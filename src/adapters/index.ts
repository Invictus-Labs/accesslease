export { adapterConfigFromEnv, type AdapterConfig } from "./config.js";
export { DEFAULT_MAX_HISTORY, DEFAULT_MAX_SEEN, EventConsumer, type ConsumerOptions, type IngestResult } from "./consumer.js";
export { checkEndpoint, classifyAddress, embeddedIPv4, EndpointError, resolveEndpoint, type EndpointPolicy, type Resolver } from "./endpoint.js";
export { pinnedGet, type PinnedRequest, type PinnedResponse } from "./pinned.js";
export { envelopeV1Schema, majorVersion, parseEnvelope, SUPPORTED_MAJOR, type EventEnvelope, type ParseResult, type RejectReason } from "./envelope.js";
export { AdapterUnavailableError, httpEventSource, pollOnce, type EventPage, type EventSource, type HttpSourceOptions, type PollSummary } from "./poller.js";
export { FileStore, MemoryStore, type ConsumerState, type ConsumerStore, type HistoryEntry, type ResourceView } from "./store.js";
