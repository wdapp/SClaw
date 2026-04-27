//! Feishu channel using the platform's persistent WebSocket connection mode.
//!
//! This keeps the existing Feishu extension setup flow (App ID/App Secret in
//! the secrets store) but runs the event loop natively in the host so local
//! desktop builds do not need a public webhook URL.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time;
use tokio_stream::wrappers::ReceiverStream;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use url::Url;

use crate::channels::{Channel, IncomingMessage, MessageStream, OutgoingResponse, StatusUpdate};
use crate::error::ChannelError;
use crate::pairing::PairingStore;

const FEISHU_CHANNEL_NAME: &str = "feishu";
const DEFAULT_API_BASE: &str = "https://open.feishu.cn";
const CONTROL_FRAME_METHOD: i32 = 0;
const DATA_FRAME_METHOD: i32 = 1;
const DEFAULT_RECONNECT_INTERVAL: Duration = Duration::from_secs(120);
const MAX_RECONNECT_ATTEMPTS: i32 = -1;

#[derive(Debug, Clone, Deserialize)]
pub struct FeishuChannelConfig {
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub app_secret: String,
    #[serde(default = "default_api_base")]
    pub api_base: String,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default = "default_dm_policy")]
    pub dm_policy: String,
    #[serde(default)]
    pub allow_from: Vec<String>,
}

fn default_api_base() -> String {
    DEFAULT_API_BASE.to_string()
}

fn default_dm_policy() -> String {
    "pairing".to_string()
}

#[derive(Debug, Clone, Default)]
struct FeishuBotInfo {
    open_id: Option<String>,
    app_name: Option<String>,
}

#[derive(Debug, Clone)]
struct TokenCache {
    token: String,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct WsRuntimeConfig {
    connect_url: String,
    service_id: i32,
    ping_interval: Duration,
    reconnect_count: i32,
    reconnect_interval: Duration,
    reconnect_nonce: Duration,
}

#[derive(Debug)]
struct PendingPayload {
    chunks: Vec<Option<Vec<u8>>>,
    created_at: Instant,
}

#[derive(Debug)]
pub struct FeishuChannel {
    config: FeishuChannelConfig,
    client: Client,
    token_cache: Arc<RwLock<Option<TokenCache>>>,
    bot_info: Arc<RwLock<FeishuBotInfo>>,
    shutdown_tx: watch::Sender<bool>,
    task_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl FeishuChannel {
    pub fn new(config: FeishuChannelConfig) -> Result<Self, ChannelError> {
        let mut config = config;
        config.api_base = config.api_base.trim_end_matches('/').to_string();
        config.dm_policy = config.dm_policy.trim().to_ascii_lowercase();

        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| ChannelError::Http(e.to_string()))?;

        let (shutdown_tx, _) = watch::channel(false);

        Ok(Self {
            config,
            client,
            token_cache: Arc::new(RwLock::new(None)),
            bot_info: Arc::new(RwLock::new(FeishuBotInfo::default())),
            shutdown_tx,
            task_handle: Arc::new(Mutex::new(None)),
        })
    }

    async fn fetch_tenant_access_token(&self) -> Result<String, ChannelError> {
        let now = Instant::now();
        if let Some(cached) = self.token_cache.read().await.clone()
            && cached.expires_at > now + Duration::from_secs(300)
        {
            return Ok(cached.token);
        }

        let url = format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            self.config.api_base
        );

        let resp = self
            .client
            .post(url)
            .json(&serde_json::json!({
                "app_id": self.config.app_id,
                "app_secret": self.config.app_secret,
            }))
            .send()
            .await
            .map_err(|e| ChannelError::AuthFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: e.to_string(),
            })?;

        let status = resp.status();
        let body: FeishuApiResponse<TenantAccessTokenData> =
            resp.json().await.map_err(|e| ChannelError::AuthFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: format!("Failed to parse token response: {e}"),
            })?;

        if !status.is_success() || body.code != 0 {
            return Err(ChannelError::AuthFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: format!(
                    "Token exchange failed with HTTP {} / code {}: {}",
                    status, body.code, body.msg
                ),
            });
        }

        let token = body
            .tenant_access_token
            .or_else(|| body.data.as_ref().map(|d| d.tenant_access_token.clone()))
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| ChannelError::AuthFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: "Token response missing tenant_access_token".to_string(),
            })?;

        let expire_secs = body
            .expire
            .or_else(|| body.data.as_ref().map(|d| d.expire))
            .unwrap_or(7200)
            .max(60) as u64;

        *self.token_cache.write().await = Some(TokenCache {
            token: token.clone(),
            expires_at: Instant::now() + Duration::from_secs(expire_secs),
        });

        Ok(token)
    }

    async fn refresh_bot_info(&self) -> Result<(), ChannelError> {
        let token = self.fetch_tenant_access_token().await?;
        let url = format!("{}/open-apis/bot/v3/info", self.config.api_base);

        let resp = self
            .client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| ChannelError::Http(e.to_string()))?;

        let status = resp.status();
        let body: FeishuApiResponse<FeishuBotData> =
            resp.json().await.map_err(|e| ChannelError::Http(e.to_string()))?;

        if !status.is_success() || body.code != 0 {
            return Err(ChannelError::Http(format!(
                "Failed to fetch bot info with HTTP {} / code {}: {}",
                status, body.code, body.msg
            )));
        }

        let mut info = self.bot_info.write().await;
        info.open_id = body.data.as_ref().and_then(|d| d.bot.open_id.clone());
        info.app_name = body.data.and_then(|d| d.bot.app_name);
        Ok(())
    }

    async fn fetch_ws_runtime_config(&self) -> Result<WsRuntimeConfig, ChannelError> {
        let url = format!("{}/callback/ws/endpoint", self.config.api_base);
        let resp = self
            .client
            .post(url)
            .header("locale", "zh")
            .json(&serde_json::json!({
                "AppID": self.config.app_id,
                "AppSecret": self.config.app_secret,
            }))
            .send()
            .await
            .map_err(|e| ChannelError::StartupFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: e.to_string(),
            })?;

        let status = resp.status();
        let body: FeishuApiResponse<FeishuWsEndpointData> =
            resp.json().await.map_err(|e| ChannelError::StartupFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: format!("Failed to parse WS endpoint response: {e}"),
            })?;

        if !status.is_success() || body.code != 0 {
            return Err(ChannelError::StartupFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: format!(
                    "Failed to fetch WS endpoint with HTTP {} / code {}: {}",
                    status, body.code, body.msg
                ),
            });
        }

        let data = body.data.ok_or_else(|| ChannelError::StartupFailed {
            name: FEISHU_CHANNEL_NAME.to_string(),
            reason: "WS endpoint response missing data".to_string(),
        })?;

        let parsed_url = Url::parse(&data.url).map_err(|e| ChannelError::StartupFailed {
            name: FEISHU_CHANNEL_NAME.to_string(),
            reason: format!("Invalid WS URL: {e}"),
        })?;
        let service_id = parsed_url
            .query_pairs()
            .find_map(|(key, value)| (key == "service_id").then_some(value.into_owned()))
            .and_then(|value| value.parse::<i32>().ok())
            .ok_or_else(|| ChannelError::StartupFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: "WS endpoint URL missing service_id".to_string(),
            })?;

        Ok(WsRuntimeConfig {
            connect_url: data.url,
            service_id,
            ping_interval: Duration::from_secs(data.client_config.ping_interval.max(1) as u64),
            reconnect_count: data.client_config.reconnect_count,
            reconnect_interval: Duration::from_secs(
                data.client_config.reconnect_interval.max(1) as u64,
            ),
            reconnect_nonce: Duration::from_secs(data.client_config.reconnect_nonce.max(0) as u64),
        })
    }

    async fn send_api_request<T: Serialize + ?Sized>(
        &self,
        method: reqwest::Method,
        url: String,
        body: Option<&T>,
    ) -> Result<(), ChannelError> {
        let token = self.fetch_tenant_access_token().await?;
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let resp = request.send().await.map_err(|e| ChannelError::SendFailed {
            name: FEISHU_CHANNEL_NAME.to_string(),
            reason: e.to_string(),
        })?;
        let status = resp.status();
        let body: FeishuApiResponse<serde_json::Value> =
            resp.json().await.map_err(|e| ChannelError::SendFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: format!("Failed to parse response body: {e}"),
            })?;
        if !status.is_success() || body.code != 0 {
            return Err(ChannelError::SendFailed {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: format!("Feishu API returned HTTP {} / code {}: {}", status, body.code, body.msg),
            });
        }
        Ok(())
    }

    async fn send_pairing_message(
        &self,
        sender_id: &str,
        sender_id_type: &str,
        code: &str,
    ) -> Result<(), ChannelError> {
        let text = format!(
            "SClaw 访问未配置。\n\n你的飞书 ID：{}\n配对码：{}\n\n请在 SClaw 中批准这条配对请求。",
            sender_id, code
        );
        self.send_message_to_target(sender_id, sender_id_type, &text).await
    }

    async fn send_message_to_target(
        &self,
        receive_id: &str,
        receive_id_type: &str,
        content: &str,
    ) -> Result<(), ChannelError> {
        let url = format!(
            "{}/open-apis/im/v1/messages?receive_id_type={}",
            self.config.api_base, receive_id_type
        );
        let body = SendMessageBody {
            receive_id: receive_id.to_string(),
            msg_type: "text".to_string(),
            content: serde_json::json!({ "text": content }).to_string(),
        };
        self.send_api_request(reqwest::Method::POST, url, Some(&body))
            .await
    }

    async fn send_reply_to_message(
        &self,
        message_id: &str,
        content: &str,
    ) -> Result<(), ChannelError> {
        let url = format!(
            "{}/open-apis/im/v1/messages/{}/reply",
            self.config.api_base, message_id
        );
        let body = ReplyMessageBody {
            msg_type: "text".to_string(),
            content: serde_json::json!({ "text": content }).to_string(),
        };
        self.send_api_request(reqwest::Method::POST, url, Some(&body))
            .await
    }
}

#[async_trait]
impl Channel for FeishuChannel {
    fn name(&self) -> &str {
        FEISHU_CHANNEL_NAME
    }

    async fn start(&self) -> Result<MessageStream, ChannelError> {
        let (tx, rx) = mpsc::channel(256);
        let mut shutdown_rx = self.shutdown_tx.subscribe();
        let config = self.config.clone();
        let client = self.client.clone();
        let token_cache = Arc::clone(&self.token_cache);
        let bot_info = Arc::clone(&self.bot_info);

        let handle = tokio::spawn(async move {
            let channel = FeishuChannel {
                config,
                client,
                token_cache,
                bot_info,
                shutdown_tx: watch::channel(false).0,
                task_handle: Arc::new(Mutex::new(None)),
            };

            if let Err(e) = channel.refresh_bot_info().await {
                tracing::warn!(error = %e, "Feishu: failed to fetch bot info before starting WS client");
            }

            let mut attempts: i32 = 0;
            loop {
                if *shutdown_rx.borrow() {
                    break;
                }

                let runtime = match channel.fetch_ws_runtime_config().await {
                    Ok(runtime) => runtime,
                    Err(e) => {
                        tracing::error!(error = %e, "Feishu: failed to fetch WS connect config");
                        attempts += 1;
                        if MAX_RECONNECT_ATTEMPTS >= 0 && attempts > MAX_RECONNECT_ATTEMPTS {
                            break;
                        }
                        let delay = DEFAULT_RECONNECT_INTERVAL;
                        tokio::select! {
                            _ = shutdown_rx.changed() => break,
                            _ = time::sleep(delay) => {}
                        }
                        continue;
                    }
                };

                match run_feishu_ws_loop(&channel, &mut shutdown_rx, &tx, runtime.clone()).await {
                    Ok(()) => break,
                    Err(e) => {
                        tracing::warn!(error = %e, "Feishu: WS loop disconnected");
                        attempts += 1;
                        if runtime.reconnect_count >= 0 && attempts > runtime.reconnect_count {
                            break;
                        }
                        let jitter = runtime.reconnect_nonce.mul_f64(rand::random::<f64>());
                        let delay = runtime.reconnect_interval + jitter;
                        tokio::select! {
                            _ = shutdown_rx.changed() => break,
                            _ = time::sleep(delay) => {}
                        }
                    }
                }
            }
        });

        *self.task_handle.lock().await = Some(handle);
        tracing::info!("Feishu channel started in persistent WebSocket mode");
        Ok(Box::pin(ReceiverStream::new(rx)))
    }

    async fn respond(
        &self,
        msg: &IncomingMessage,
        response: OutgoingResponse,
    ) -> Result<(), ChannelError> {
        let message_id = msg
            .metadata
            .get("message_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| ChannelError::MissingRoutingTarget {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: "message_id missing from metadata".to_string(),
            })?;
        self.send_reply_to_message(message_id, &response.content).await
    }

    async fn send_status(
        &self,
        _status: StatusUpdate,
        _metadata: &serde_json::Value,
    ) -> Result<(), ChannelError> {
        Ok(())
    }

    async fn broadcast(
        &self,
        user_id: &str,
        response: OutgoingResponse,
    ) -> Result<(), ChannelError> {
        self.send_message_to_target(user_id, "open_id", &response.content)
            .await
    }

    async fn health_check(&self) -> Result<(), ChannelError> {
        self.fetch_ws_runtime_config().await.map(|_| ())
    }

    fn conversation_context(&self, metadata: &serde_json::Value) -> HashMap<String, String> {
        let mut context = HashMap::new();
        if let Some(chat_type) = metadata.get("chat_type").and_then(|value| value.as_str()) {
            context.insert("chat_type".to_string(), chat_type.to_string());
        }
        if let Some(chat_id) = metadata.get("chat_id").and_then(|value| value.as_str()) {
            context.insert("chat_id".to_string(), chat_id.to_string());
        }
        context
    }

    async fn shutdown(&self) -> Result<(), ChannelError> {
        let _ = self.shutdown_tx.send(true);
        if let Some(handle) = self.task_handle.lock().await.take() {
            handle.abort();
        }
        Ok(())
    }
}

async fn run_feishu_ws_loop(
    channel: &FeishuChannel,
    shutdown_rx: &mut watch::Receiver<bool>,
    tx: &mpsc::Sender<IncomingMessage>,
    runtime: WsRuntimeConfig,
) -> Result<(), ChannelError> {
    let (ws_stream, _) =
        connect_async(runtime.connect_url.as_str())
            .await
            .map_err(|e| ChannelError::Disconnected {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: e.to_string(),
            })?;

    let (mut sink, mut stream) = ws_stream.split();
    let mut ping_interval = time::interval(runtime.ping_interval);
    let mut pending: HashMap<String, PendingPayload> = HashMap::new();

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                let _ = sink.close().await;
                return Ok(());
            }
            _ = ping_interval.tick() => {
                let ping = ProtoFrame {
                    seq_id: 0,
                    log_id: 0,
                    service: runtime.service_id,
                    method: CONTROL_FRAME_METHOD,
                    headers: vec![ProtoHeader::new("type", "ping")],
                    payload_encoding: String::new(),
                    payload_type: String::new(),
                    payload: Vec::new(),
                    log_id_new: String::new(),
                };
                sink.send(WsMessage::Binary(ping.encode_to_vec().into()))
                    .await
                    .map_err(|e| ChannelError::Disconnected {
                        name: FEISHU_CHANNEL_NAME.to_string(),
                        reason: e.to_string(),
                    })?;
            }
            frame = stream.next() => {
                let Some(frame) = frame else {
                    return Err(ChannelError::Disconnected {
                        name: FEISHU_CHANNEL_NAME.to_string(),
                        reason: "server closed WebSocket connection".to_string(),
                    });
                };
                let frame = frame.map_err(|e| ChannelError::Disconnected {
                    name: FEISHU_CHANNEL_NAME.to_string(),
                    reason: e.to_string(),
                })?;
                handle_ws_message(channel, tx, &mut sink, &mut pending, runtime.service_id, frame).await?;
            }
        }
    }
}

async fn handle_ws_message<S>(
    channel: &FeishuChannel,
    tx: &mpsc::Sender<IncomingMessage>,
    sink: &mut S,
    pending: &mut HashMap<String, PendingPayload>,
    default_service_id: i32,
    frame: WsMessage,
) -> Result<(), ChannelError>
where
    S: futures::Sink<WsMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let bytes = match frame {
        WsMessage::Binary(bytes) => bytes,
        WsMessage::Ping(payload) => {
            sink.send(WsMessage::Pong(payload))
                .await
                .map_err(|e| ChannelError::Disconnected {
                    name: FEISHU_CHANNEL_NAME.to_string(),
                    reason: e.to_string(),
                })?;
            return Ok(());
        }
        WsMessage::Close(_) => {
            return Err(ChannelError::Disconnected {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: "server requested close".to_string(),
            });
        }
        _ => return Ok(()),
    };

    let decoded = ProtoFrame::decode(bytes.as_ref()).map_err(|e| ChannelError::InvalidMessage(e.to_string()))?;

    if decoded.method == CONTROL_FRAME_METHOD {
        return Ok(());
    }
    if decoded.method != DATA_FRAME_METHOD {
        return Ok(());
    }

    let header_map: HashMap<String, String> = decoded
        .headers
        .iter()
        .map(|header| (header.key.clone(), header.value.clone()))
        .collect();
    if header_map.get("type").map(String::as_str) != Some("event") {
        return Ok(());
    }

    let merged = merge_payload_chunks(
        pending,
        header_map.get("message_id").map(String::as_str).unwrap_or_default(),
        header_map
            .get("sum")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1),
        header_map
            .get("seq")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0),
        decoded.payload.clone(),
    );

    if let Some(payload_bytes) = merged {
        let event: FeishuWsEventEnvelope = serde_json::from_slice(&payload_bytes)
            .map_err(|e| ChannelError::InvalidMessage(e.to_string()))?;

        if let Some(message) = build_incoming_message(channel, event).await? {
            tx.send(message).await.map_err(|_| ChannelError::Disconnected {
                name: FEISHU_CHANNEL_NAME.to_string(),
                reason: "receiver dropped".to_string(),
            })?;
        }
    }

    let elapsed_ms = 0u64;
    let mut ack_headers = decoded.headers.clone();
    ack_headers.push(ProtoHeader::new("biz_rt", elapsed_ms.to_string()));
    let ack = ProtoFrame {
        seq_id: decoded.seq_id,
        log_id: decoded.log_id,
        service: if decoded.service == 0 { default_service_id } else { decoded.service },
        method: decoded.method,
        headers: ack_headers,
        payload_encoding: decoded.payload_encoding,
        payload_type: decoded.payload_type,
        payload: serde_json::to_vec(&serde_json::json!({ "code": 200 })).unwrap_or_default(),
        log_id_new: decoded.log_id_new,
    };
    sink.send(WsMessage::Binary(ack.encode_to_vec().into()))
        .await
        .map_err(|e| ChannelError::Disconnected {
            name: FEISHU_CHANNEL_NAME.to_string(),
            reason: e.to_string(),
        })?;

    Ok(())
}

fn merge_payload_chunks(
    pending: &mut HashMap<String, PendingPayload>,
    message_id: &str,
    sum: usize,
    seq: usize,
    payload: Vec<u8>,
) -> Option<Vec<u8>> {
    pending.retain(|_, entry| entry.created_at.elapsed() < Duration::from_secs(10));

    if message_id.is_empty() || sum <= 1 {
        return Some(payload);
    }

    let entry = pending
        .entry(message_id.to_string())
        .or_insert_with(|| PendingPayload {
            chunks: vec![None; sum.max(1)],
            created_at: Instant::now(),
        });

    if entry.chunks.len() < sum {
        entry.chunks.resize(sum, None);
    }
    if seq < entry.chunks.len() {
        entry.chunks[seq] = Some(payload);
    }

    if entry.chunks.iter().all(Option::is_some) {
        let mut merged = Vec::new();
        for chunk in entry.chunks.iter_mut() {
            if let Some(bytes) = chunk.take() {
                merged.extend(bytes);
            }
        }
        pending.remove(message_id);
        return Some(merged);
    }

    None
}

async fn build_incoming_message(
    channel: &FeishuChannel,
    envelope: FeishuWsEventEnvelope,
) -> Result<Option<IncomingMessage>, ChannelError> {
    if envelope.header.event_type != "im.message.receive_v1" {
        return Ok(None);
    }

    let sender = resolve_sender_identity(&envelope.event.sender.sender_id);
    let Some((sender_id, sender_id_type)) = sender else {
        return Ok(None);
    };

    if envelope.event.sender.sender_type.as_deref() == Some("app") {
        return Ok(None);
    }

    let bot_info = channel.bot_info.read().await.clone();
    if bot_info.open_id.as_deref() == Some(sender_id.as_str()) {
        return Ok(None);
    }

    if let Some(owner_id) = channel.config.owner_id.as_deref()
        && sender_id != owner_id
    {
        return Ok(None);
    }

    let text = extract_text_content(
        &envelope.event.message.content,
        envelope.event.message.mentions.as_deref().unwrap_or(&[]),
    );
    if text.is_empty() {
        return Ok(None);
    }

    let chat_type = envelope.event.message.chat_type.as_deref().unwrap_or("unknown");
    if chat_type == "group" && !is_bot_mentioned(&envelope.event.message, &bot_info) {
        return Ok(None);
    }

    let configured_allow: HashSet<String> = channel.config.allow_from.iter().cloned().collect();
    let paired_allow: HashSet<String> = PairingStore::new()
        .read_allow_from(FEISHU_CHANNEL_NAME)
        .unwrap_or_default()
        .into_iter()
        .collect();

    let is_allowed = configured_allow.contains(&sender_id) || paired_allow.contains(&sender_id);

    if chat_type == "p2p" && channel.config.dm_policy == "pairing" && !is_allowed {
        let meta = serde_json::json!({
            "sender_id": sender_id,
            "sender_id_type": sender_id_type,
            "chat_id": envelope.event.message.chat_id,
            "chat_type": chat_type,
        });
        if let Ok(result) = PairingStore::new().upsert_request(FEISHU_CHANNEL_NAME, &sender_id, Some(meta))
            && result.created
        {
            let _ = channel
                .send_pairing_message(&sender_id, &sender_id_type, &result.code)
                .await;
        }
        return Ok(None);
    }

    if !configured_allow.is_empty() && !is_allowed && chat_type != "p2p" {
        return Ok(None);
    }

    let metadata = serde_json::json!({
        "chat_id": envelope.event.message.chat_id,
        "chat_type": chat_type,
        "message_id": envelope.event.message.message_id,
        "sender_id": sender_id,
        "sender_id_type": sender_id_type,
        "target": envelope.event.message.chat_id,
    });

    let thread_id = envelope
        .event
        .message
        .root_id
        .clone()
        .or(envelope.event.message.parent_id.clone())
        .unwrap_or_else(|| envelope.event.message.chat_id.clone());

    let msg = IncomingMessage::new(FEISHU_CHANNEL_NAME, sender_id, text)
        .with_thread(thread_id)
        .with_metadata(metadata);

    Ok(Some(msg))
}

fn resolve_sender_identity(sender_id: &FeishuSenderId) -> Option<(String, String)> {
    sender_id
        .open_id
        .as_ref()
        .map(|id| (id.clone(), "open_id".to_string()))
        .or_else(|| {
            sender_id
                .user_id
                .as_ref()
                .map(|id| (id.clone(), "user_id".to_string()))
        })
        .or_else(|| {
            sender_id
                .union_id
                .as_ref()
                .map(|id| (id.clone(), "union_id".to_string()))
        })
}

fn is_bot_mentioned(message: &FeishuMessage, bot_info: &FeishuBotInfo) -> bool {
    let mentions = message.mentions.as_deref().unwrap_or(&[]);
    if mentions.is_empty() {
        return false;
    }

    if let Some(bot_open_id) = bot_info.open_id.as_deref()
        && mentions.iter().any(|mention| mention.id.open_id.as_deref() == Some(bot_open_id))
    {
        return true;
    }

    let bot_name = bot_info
        .app_name
        .as_deref()
        .map(|name| name.trim().to_ascii_lowercase());
    if let Some(bot_name) = bot_name {
        return mentions.iter().any(|mention| {
            mention
                .name
                .as_deref()
                .map(|name| name.trim().to_ascii_lowercase() == bot_name)
                .unwrap_or(false)
        });
    }

    false
}

fn extract_text_content(content: &str, mentions: &[FeishuMention]) -> String {
    let parsed: TextContent = match serde_json::from_str(content) {
        Ok(parsed) => parsed,
        Err(_) => return String::new(),
    };

    let mut text = parsed.text;
    for mention in mentions {
        if let Some(name) = mention.name.as_deref() {
            text = text.replace(&mention.key, name);
        }
    }
    text.trim().to_string()
}

#[derive(Debug, Deserialize)]
struct FeishuWsEventEnvelope {
    header: FeishuEventHeader,
    event: FeishuMessageReceiveEvent,
}

#[derive(Debug, Deserialize)]
struct FeishuEventHeader {
    event_type: String,
}

#[derive(Debug, Deserialize)]
struct FeishuMessageReceiveEvent {
    sender: FeishuSender,
    message: FeishuMessage,
}

#[derive(Debug, Deserialize)]
struct FeishuSender {
    sender_id: FeishuSenderId,
    #[serde(default)]
    sender_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FeishuSenderId {
    #[serde(default)]
    open_id: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    union_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FeishuMessage {
    message_id: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    root_id: Option<String>,
    chat_id: String,
    #[serde(default)]
    chat_type: Option<String>,
    #[serde(default)]
    mentions: Option<Vec<FeishuMention>>,
    content: String,
}

#[derive(Debug, Deserialize)]
struct FeishuMention {
    key: String,
    id: FeishuSenderId,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TextContent {
    text: String,
}

#[derive(Debug, Serialize)]
struct SendMessageBody {
    receive_id: String,
    msg_type: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ReplyMessageBody {
    msg_type: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct FeishuApiResponse<T> {
    code: i32,
    msg: String,
    #[serde(default)]
    data: Option<T>,
    #[serde(default)]
    tenant_access_token: Option<String>,
    #[serde(default)]
    expire: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct TenantAccessTokenData {
    tenant_access_token: String,
    expire: i64,
}

#[derive(Debug, Default, Deserialize)]
struct FeishuBotData {
    bot: FeishuBotInfoData,
}

#[derive(Debug, Default, Deserialize)]
struct FeishuBotInfoData {
    #[serde(default)]
    app_name: Option<String>,
    #[serde(default)]
    open_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FeishuWsEndpointData {
    #[serde(rename = "URL")]
    url: String,
    #[serde(rename = "ClientConfig")]
    client_config: FeishuWsClientConfig,
}

#[derive(Debug, Default, Deserialize)]
struct FeishuWsClientConfig {
    #[serde(rename = "PingInterval")]
    ping_interval: i64,
    #[serde(rename = "ReconnectCount")]
    reconnect_count: i32,
    #[serde(rename = "ReconnectInterval")]
    reconnect_interval: i64,
    #[serde(rename = "ReconnectNonce")]
    reconnect_nonce: i64,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct ProtoHeader {
    #[prost(string, tag = "1")]
    key: String,
    #[prost(string, tag = "2")]
    value: String,
}

impl ProtoHeader {
    fn new(key: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
        }
    }
}

#[derive(Clone, PartialEq, ProstMessage)]
struct ProtoFrame {
    #[prost(uint64, tag = "1")]
    seq_id: u64,
    #[prost(uint64, tag = "2")]
    log_id: u64,
    #[prost(int32, tag = "3")]
    service: i32,
    #[prost(int32, tag = "4")]
    method: i32,
    #[prost(message, repeated, tag = "5")]
    headers: Vec<ProtoHeader>,
    #[prost(string, tag = "6")]
    payload_encoding: String,
    #[prost(string, tag = "7")]
    payload_type: String,
    #[prost(bytes, tag = "8")]
    payload: Vec<u8>,
    #[prost(string, tag = "9")]
    log_id_new: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_content_replaces_mentions() {
        let content = r#"{"text":"hello @_user_1"}"#;
        let mentions = vec![FeishuMention {
            key: "@_user_1".to_string(),
            id: FeishuSenderId {
                open_id: Some("ou_x".to_string()),
                user_id: None,
                union_id: None,
            },
            name: Some("Wanda".to_string()),
        }];
        assert_eq!(extract_text_content(content, &mentions), "hello Wanda");
    }

    #[test]
    fn merge_payload_chunks_reassembles_multi_part_payload() {
        let mut pending = HashMap::new();
        assert!(merge_payload_chunks(&mut pending, "msg", 2, 0, br#"{"foo":"#.to_vec()).is_none());
        let merged = merge_payload_chunks(&mut pending, "msg", 2, 1, br#""bar"}"#.to_vec())
            .expect("merged payload");
        assert_eq!(String::from_utf8(merged).unwrap(), r#"{"foo":"bar"}"#);
    }

    #[test]
    fn mention_gate_matches_by_bot_name_when_open_id_is_unknown() {
        let message = FeishuMessage {
            message_id: "m1".to_string(),
            parent_id: None,
            root_id: None,
            chat_id: "c1".to_string(),
            chat_type: Some("group".to_string()),
            mentions: Some(vec![FeishuMention {
                key: "@_user_1".to_string(),
                id: FeishuSenderId {
                    open_id: Some("ou_other".to_string()),
                    user_id: None,
                    union_id: None,
                },
                name: Some("SClaw Bot".to_string()),
            }]),
            content: r#"{"text":"@_user_1 hi"}"#.to_string(),
        };
        assert!(is_bot_mentioned(
            &message,
            &FeishuBotInfo {
                open_id: None,
                app_name: Some("SClaw Bot".to_string()),
            }
        ));
    }
}
