/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library'
/* eslint-enable */

import { GeminiLLMChatMessage, LLMChatMessage, LLMFIMMessage, ModelListParams, OllamaModelResponse, OnError, OnFinalMessage, OnText, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, displayInfoOfProviderName, FeatureName, ModelSelectionOptions, OverridesOfModel, ProviderName, SettingsOfProvider } from '../../common/cortexideSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { perfSpanTracker, type LocalLLMPerfSpan } from '../../common/localLLMPerfSpan.js';
import { isLocalProvider as checkIsLocalProvider, getBackendCapabilities } from '../../common/localLLMCapabilities.js';
import { generateFIMCacheKey, generateChatCacheKey } from '../../common/localLLMCacheKey.js';

const getGoogleApiKey = async () => {
	// module‑level singleton
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken()
	if (!key) throw new Error(`Google API failed to generate a key.`)
	return key
}




type InternalCommonMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	modelName: string;
	_setAborter: (aborter: () => void) => void;
}

type SendChatParams_Internal = InternalCommonMessageParams & {
	messages: LLMChatMessage[];
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
	mcpTools: InternalToolInfo[] | undefined;
}
type SendFIMParams_Internal = InternalCommonMessageParams & { messages: LLMFIMMessage; separateSystemMessage: string | undefined; featureName?: FeatureName; }
export type ListParams_Internal<ModelResponse> = ModelListParams<ModelResponse>


const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`

// ------------ SDK POOLING FOR LOCAL PROVIDERS ------------

/**
 * In-memory cache for OpenAI-compatible SDK clients (for local providers only).
 * Keyed by: `${providerName}:${endpoint}:${apiKeyHash}`
 * This avoids recreating clients on every request, improving connection reuse.
 */
const openAIClientCache = new Map<string, OpenAI>()

/**
 * In-memory cache for Ollama SDK clients.
 * Keyed by: `${endpoint}`
 */
const ollamaClientCache = new Map<string, Ollama>()

/**
 * Simple hash function for API keys (for cache key generation).
 * Only used for local providers where security is less critical.
 */
const hashApiKey = (apiKey: string | undefined): string => {
	if (!apiKey) return 'noop'
	// Simple hash - just use first 8 chars for cache key (not for security)
	return apiKey.substring(0, 8)
}

/**
 * Build cache key for OpenAI-compatible client.
 * Format: `${providerName}:${endpoint}:${apiKeyHash}`
 */
const buildOpenAICacheKey = (providerName: ProviderName, settingsOfProvider: SettingsOfProvider): string => {
	let endpoint = ''
	let apiKey = 'noop'

	if (providerName === 'openAI') {
		apiKey = settingsOfProvider[providerName]?.apiKey || ''
	} else if (providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio') {
		endpoint = settingsOfProvider[providerName]?.endpoint || ''
	} else if (providerName === 'openAICompatible' || providerName === 'liteLLM') {
		endpoint = settingsOfProvider[providerName]?.endpoint || ''
		apiKey = settingsOfProvider[providerName]?.apiKey || ''
	}

	return `${providerName}:${endpoint}:${hashApiKey(apiKey)}`
}

/**
 * Get or create OpenAI-compatible client with caching for local providers.
 * For local providers (ollama, vLLM, lmStudio, localhost openAICompatible/liteLLM),
 * we cache clients to reuse connections. Cloud providers always get new instances.
 *
 * PERFORMANCE: For local providers, this is typically a cache hit (instant return).
 * For cloud providers or first request, client creation is async but fast.
 */
const getOpenAICompatibleClient = async ({ settingsOfProvider, providerName, includeInPayload }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName, includeInPayload?: { [s: string]: any } }): Promise<OpenAI> => {
	// Detect if this is a local provider
	const endpoint = settingsOfProvider[providerName]?.endpoint || ''
	const isLocalProvider = checkIsLocalProvider(providerName, endpoint)

	// Only cache for local providers
	if (isLocalProvider) {
		const cacheKey = buildOpenAICacheKey(providerName, settingsOfProvider)
		const cached = openAIClientCache.get(cacheKey)
		if (cached) {
			// PERFORMANCE: Cache hit - return immediately (no async overhead)
			return cached
		}
	}

	// Create new client (will cache if local)
	// PERFORMANCE: For local providers, client creation is synchronous (no await needed except for googleVertex)
	// But we keep async for consistency and to handle googleVertex case
	const client = await newOpenAICompatibleSDK({ settingsOfProvider, providerName, includeInPayload })

	// Cache if local provider (immediate caching for connection reuse)
	if (isLocalProvider) {
		const cacheKey = buildOpenAICacheKey(providerName, settingsOfProvider)
		openAIClientCache.set(cacheKey, client)
	}

	return client
}

/**
 * Get or create Ollama client with caching.
 * Optimized for local performance with timeout and connection settings.
 */
const getOllamaClient = ({ endpoint }: { endpoint: string }): Ollama => {
	if (!endpoint) throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in CortexIDE Settings if you want the default url).`)

	const cached = ollamaClientCache.get(endpoint)
	if (cached) {
		return cached
	}

	// Parse endpoint URL - Ollama SDK expects hostname:port format (without protocol)
	// But it can also accept a full URL, so we'll extract just the hostname:port part
	let host: string
	try {
		const url = new URL(endpoint)
		host = url.hostname
		// Include port if specified (default Ollama port is 11434)
		if (url.port) {
			host = `${host}:${url.port}`
		} else if (url.protocol === 'http:' && !endpoint.includes(':11434')) {
			// Default Ollama port is 11434
			host = `${host}:11434`
		}
	} catch {
		// If endpoint is not a full URL, try to clean it up
		// Remove protocol if present, but keep hostname:port
		host = endpoint.replace(/^https?:\/\//, '')
		// If no port specified and it looks like a hostname, add default port
		if (!host.includes(':') && !host.includes('localhost') && !host.includes('127.0.0.1')) {
			// This might be just a hostname, but we'll use it as-is
		}
	}

	console.debug('[getOllamaClient] Parsed endpoint:', endpoint, '-> host:', host)

	// Configure Ollama client with timeout and connection optimizations for local models
	// The Ollama SDK uses fetch internally, and we can pass fetch options
	// Note: Ollama SDK v0.x doesn't expose timeout directly, but we can use fetch options
	const ollama = new Ollama({
		host: host,
		// The Ollama SDK internally uses fetch, and we can configure it via environment
		// For now, we rely on the SDK's default behavior but ensure endpoint is correct
		// Future: If Ollama SDK adds timeout support, configure it here (e.g., timeout: 30_000)
	})
	ollamaClientCache.set(endpoint, ollama)
	return ollama
}

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------

const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) return undefined
	try {
		return JSON.parse(s)
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`)
	}
}

// Note: Void uses hardcoded max_tokens: 300 for all FIM requests, so we match that approach
// Removed computeMaxTokensForLocalProvider as it's no longer needed (Void doesn't vary tokens by feature)

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload }: { settingsOfProvider: SettingsOfProvider, providerName: ProviderName, includeInPayload?: { [s: string]: any } }) => {
	// Network optimizations: timeouts and connection reuse
	// The OpenAI SDK handles HTTP keep-alive and connection pooling internally
	// Use shorter timeout for local models (they're on localhost, should be fast)

	// Detect local providers using centralized function
	const isLocalProvider = checkIsLocalProvider(providerName, settingsOfProvider)

	// Optimize timeouts: local models should respond quickly, use aggressive timeouts
	// Cloud models get more time for network latency
	const timeoutMs = isLocalProvider ? 30_000 : 60_000 // 30s for local, 60s for remote
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		timeout: timeoutMs,
		maxRetries: isLocalProvider ? 0 : 1, // No retries for local models (fail fast), 1 retry for cloud
		// CRITICAL: For localhost, connection reuse eliminates TCP handshake overhead (saves 10-50ms per request)
		// The OpenAI SDK uses keep-alive by default, but we ensure it's enabled
		// httpAgent: undefined lets SDK use its optimized default agent with keep-alive
		httpAgent: undefined, // SDK's default agent has keep-alive enabled, optimal for localhost
		...includeInPayload,
	}
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts })
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://cortexide.com', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'CortexIDE', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		})
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName]
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`
		const apiKey = await getGoogleApiKey()
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName]
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const options = { endpoint, apiKey: thisConfig.apiKey, apiVersion };
		return new AzureOpenAI({ ...options, ...commonPayloadOpts });
	}
	else if (providerName === 'awsBedrock') {
		/**
		  * We treat Bedrock as *OpenAI-compatible only through a proxy*:
		  *   • LiteLLM default → http://localhost:4000/v1
		  *   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
		  *
		  * The native Bedrock runtime endpoint
		  *   https://bedrock-runtime.<region>.amazonaws.com
		  * is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
		  */
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock

		// ① use the user-supplied proxy if present
		// ② otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1'

		// Normalize: make sure we end with “/v1”
		if (!baseURL.endsWith('/v1'))
			baseURL = baseURL.replace(/\/+$/, '') + '/v1'

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts })
	}


	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'openAICompatible') {
		const thisConfig = settingsOfProvider[providerName]
		const headers = parseHeadersJSON(thisConfig.headersJSON)
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts })
	}
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName]
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts })
	}

	else throw new Error(`CortexIDE providerName was invalid: ${providerName}.`)
}


// Match Void's approach: Non-streaming FIM for OpenAI-compatible providers
const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel, featureName }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	// Match Void: Use hardcoded max_tokens: 300 for FIM (Void doesn't vary this)
	const maxTokensForThisCall = 300;

	// Get client (cached for local, so this is fast)
	const openai = await getOpenAICompatibleClient({ providerName, settingsOfProvider, includeInPayload: additionalOpenAIPayload });

	// Performance instrumentation
	const endpoint = settingsOfProvider[providerName]?.endpoint || ''
	const isLocalProvider = checkIsLocalProvider(providerName, endpoint)
	const promptBytes = (prefix + suffix).length;
	const promptTokensEst = Math.ceil(promptBytes / 4);
	let perfSpan: LocalLLMPerfSpan | undefined;
	if (isLocalProvider) {
		const temperature = (additionalOpenAIPayload as any)?.temperature;
		const topP = (additionalOpenAIPayload as any)?.top_p;
		perfSpan = perfSpanTracker.createSpan(
			providerName,
			modelName,
			featureName === 'Autocomplete' ? 'complete' : 'edit',
			promptTokensEst,
			promptBytes,
			maxTokensForThisCall,
			temperature,
			topP
		);
	}

	// Step 4A: Server-side caching (capability-gated)
	// Generate cache key if backend supports it
	const capabilities = getBackendCapabilities(providerName);
	const shouldUseServerSideCache = capabilities.supportsPromptCachingKey() || capabilities.supportsServerSideContextCaching();
	const cacheKey = shouldUseServerSideCache ? generateFIMCacheKey(prefix, modelName) : undefined;

	// Build request payload with optional cache key
	const requestPayload: OpenAI.Completions.CompletionCreateParams = {
		model: modelName,
		prompt: prefix,
		suffix: suffix,
		stop: stopTokens,
		max_tokens: maxTokensForThisCall,
	};

	// Add cache key if supported (vLLM and some other backends support this)
	if (cacheKey && shouldUseServerSideCache) {
		// vLLM supports cache_config parameter for prefix caching
		// Format: { "cache_config": { "prompt_cache_key": cacheKey } }
		(requestPayload as any).extra_body = {
			cache_config: {
				prompt_cache_key: cacheKey,
			},
		};
	}

	// Match Void: Non-streaming FIM using .then()/.catch() pattern
	openai.completions
		.create(requestPayload)
		.then(async response => {
			const fullText = response.choices[0]?.text || '';
			if (perfSpan) {
				perfSpanTracker.completeSpan(perfSpan, true);
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			if (perfSpan) {
				const errorCategory = error instanceof OpenAI.APIError ? `APIError_${error.status}` : 'Unknown';
				perfSpanTracker.completeSpan(perfSpan, false, errorCategory);
			}
			if (error instanceof OpenAI.APIError && error.status === 401) {
				onError({ message: invalidApiKeyMessage(providerName), fullError: error });
			} else {
				onError({ message: error + '', fullError: error });
			}
		})
}

// Match Void: Use native Ollama SDK for FIM (better than OpenAI-compatible endpoint)
const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama
	const ollama = getOllamaClient({ endpoint: thisConfig.endpoint })

	let fullText = ''
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: 300, // Match Void: hardcoded 300 tokens
		},
		raw: true,
		stream: true, // Stream to get tokens as they come, but we accumulate and call onFinalMessage once
	})
		.then(async stream => {
			_setAborter(() => stream.abort())
			for await (const chunk of stream) {
				const newText = chunk.response
				fullText += newText
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null })
		})
		.catch((error) => {
			onError({ message: error + '', fullError: error })
		})
}

// Use native Ollama SDK for chat (much faster than OpenAI-compatible endpoint)
// This bypasses the OpenAI SDK wrapper and calls Ollama directly
// Ollama now supports native tool calling (as of 2024), so we can use it for agent mode too!
const sendOllamaChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter, separateSystemMessage, overridesOfModel, chatMode, mcpTools }: SendChatParams_Internal): Promise<void> => {
	const thisConfig = settingsOfProvider.ollama
	console.debug('[sendOllamaChat] Using native Ollama SDK. Endpoint:', thisConfig.endpoint, 'Model:', modelName)
	const ollama = getOllamaClient({ endpoint: thisConfig.endpoint })

	// Get tools if needed (for agent mode or when MCP tools are present)
	const potentialTools = openAITools(chatMode, mcpTools)
	const hasTools = potentialTools && potentialTools.length > 0

	// Check if model likely supports native tool calling
	// Models that DON'T support native tool calling: llama3 (without .1), older models
	// Models that DO support native tool calling: llama3.1, llama3.2, llama3.3, qwen2.5, qwq, deepseek-r1, devstral, etc.
	// We check the model name to avoid unnecessary errors, but still try for unknown models
	const modelNameLower = modelName.toLowerCase()
	const knownUnsupportedModels = ['llama3:', 'llama3:latest', 'llama3:8b', 'llama3:70b', 'llama3:8b-instruct', 'llama3:70b-instruct']
	const isKnownUnsupported = knownUnsupportedModels.some(unsupported => modelNameLower.includes(unsupported))

	if (hasTools) {
		if (isKnownUnsupported) {
			// Skip native tool calling attempt for known unsupported models - go straight to OpenAI-compatible endpoint
			console.debug('[sendOllamaChat] Tools detected, but model doesn\'t support native tool calling, using OpenAI-compatible endpoint')
			return _sendOpenAICompatibleChat({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions: undefined, modelName, _setAborter, providerName: 'ollama', chatMode, separateSystemMessage, overridesOfModel, mcpTools })
		} else {
			console.debug('[sendOllamaChat] Tools detected, attempting native Ollama tool calling support')
		}
	}

	// Convert LLMChatMessage[] to Ollama's message format
	// Ollama expects: { role: 'user' | 'assistant' | 'system', content: string }[]
	// Note: For tool calls, we need to handle tool role messages and tool_calls in assistant messages
	const ollamaMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = []

	// Add system message if provided
	if (separateSystemMessage) {
		ollamaMessages.push({ role: 'system', content: separateSystemMessage })
	}

	// Convert messages to Ollama format
	for (const msg of messages) {
		if ('role' in msg) {
			if (msg.role === 'system' || msg.role === 'developer') {
				// System messages already handled above, or add here if no separateSystemMessage
				if (!separateSystemMessage && 'content' in msg && typeof msg.content === 'string') {
					ollamaMessages.push({ role: 'system', content: msg.content })
				}
			} else if (msg.role === 'user') {
				// Extract text content from user message (handle OpenAI/Anthropic format, skip Gemini)
				let content = ''
				if ('content' in msg) {
					if (typeof msg.content === 'string') {
						content = msg.content
					} else if (Array.isArray(msg.content)) {
						// Extract text from content array
						content = msg.content
							.filter((part: any) => part.type === 'text')
							.map((part: any) => part.text)
							.join(' ')
					}
				}
				// Skip Gemini messages (they use 'parts' not 'content')
				if (content) {
					ollamaMessages.push({ role: 'user', content })
				}
			} else if (msg.role === 'assistant') {
				// Extract text content from assistant message (handle OpenAI/Anthropic format, skip Gemini)
				let content = ''
				if ('content' in msg) {
					if (typeof msg.content === 'string') {
						content = msg.content
					} else if (Array.isArray(msg.content)) {
						// Extract text from content array
						content = msg.content
							.filter((part: any) => part.type === 'text')
							.map((part: any) => part.text)
							.join(' ')
					}
				}
				// Skip Gemini messages (they use 'parts' not 'content')
				if (content) {
					ollamaMessages.push({ role: 'assistant', content })
				}
				// Note: Ollama's native SDK handles tool_calls automatically if tools are provided
			} else if (msg.role === 'tool' && hasTools) {
				// For tool responses, we need to convert them to user messages with tool results
				// Ollama's native SDK expects tool results in a specific format
				// For now, we'll include tool results as part of the conversation context
				if ('content' in msg && typeof msg.content === 'string') {
					ollamaMessages.push({ role: 'user', content: msg.content })
				}
			}
		}
	}

	// Get model options from overrides if available
	const { additionalOpenAIPayload, contextWindow } = getModelCapabilities('ollama', modelName, overridesOfModel)
	const options: any = {}
	if (additionalOpenAIPayload) {
		if (additionalOpenAIPayload.temperature !== undefined) {
			options.temperature = additionalOpenAIPayload.temperature
		}
		if (additionalOpenAIPayload.top_p !== undefined) {
			options.top_p = additionalOpenAIPayload.top_p
		}
	}

	// Part F: Ollama Performance Optimizations
	// Based on Ollama best practices for speed:
	// - num_ctx: Context window size (use model's context window, but cap for performance)
	// - num_predict: Max tokens to generate (null = unlimited, but we can set reasonable defaults)
	// - num_thread: Number of threads (Ollama auto-detects, but can be set)
	// Note: These are optional and Ollama will use defaults if not set
	// For local models, we optimize for speed over maximum context
	if (contextWindow) {
		// Cap context window for performance (local models are slower with very large contexts)
		// Use 75% of model's context window or 32k, whichever is smaller (for speed)
		const effectiveCtx = Math.min(Math.floor(contextWindow * 0.75), 32_000);
		options.num_ctx = effectiveCtx;
	}
	// num_predict: Let Ollama use default (unlimited) unless user specifies
	// num_thread: Let Ollama auto-detect (usually optimal)

	let fullTextSoFar = ''

	// Ensure we have at least one message
	if (ollamaMessages.length === 0) {
		console.error('[sendOllamaChat] No messages to send after conversion. Original messages count:', messages.length)
		onError({ message: 'No messages to send to Ollama. Please provide at least one message.', fullError: null })
		return
	}

	console.debug('[sendOllamaChat] Sending request with', ollamaMessages.length, 'messages. Options:', Object.keys(options).length > 0 ? options : 'none', 'Tools:', hasTools ? potentialTools?.length : 0)

	// Prepare chat request - Ollama's native SDK now supports tools parameter
	const chatRequest: any = {
		model: modelName,
		messages: ollamaMessages,
		stream: true,
		options: Object.keys(options).length > 0 ? options : undefined,
	}

	// Add tools if available (Ollama supports native tool calling)
	if (hasTools && potentialTools) {
		chatRequest.tools = potentialTools
	}

	let toolName = ''
	let toolId = ''
	let toolParamsStr = ''

	return ollama.chat(chatRequest)
		.then(async stream => {
			console.debug('[sendOllamaChat] Stream started successfully')
			_setAborter(() => stream.abort())
			let chunkCount = 0
			for await (const chunk of stream) {
				chunkCount++
				// Ollama chat streaming format: chunk.message.content
				// The ChatResponse type has a message property with content
				const newText = chunk.message?.content || ''
				if (newText) {
					fullTextSoFar += newText
				}

				// Handle tool calls if present (Ollama's native tool calling format)
				// Ollama's tool_calls structure matches OpenAI format: { id, type, function: { name, arguments } }
				const toolCalls = chunk.message?.tool_calls
				if (toolCalls && toolCalls.length > 0) {
					const toolCall = toolCalls[0] // Handle first tool call
					if (toolCall.function) {
						toolName += toolCall.function.name || ''
						toolParamsStr += toolCall.function.arguments || ''
						// Ollama's tool call may have id property, but it's optional in streaming
						toolId += (toolCall as any).id || ''
					}
				}

				// Call onText immediately for streaming updates (no batching delay)
				if (newText || (toolCalls && toolCalls.length > 0)) {
					onText({
						fullText: fullTextSoFar,
						fullReasoning: '',
						toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
					})
				}

				if (chunkCount === 1 && !newText && !toolCalls) {
					// Log first chunk structure for debugging
					console.debug('[sendOllamaChat] First chunk structure:', JSON.stringify(chunk, null, 2))
				}
			}
			console.debug('[sendOllamaChat] Stream completed. Total chunks:', chunkCount, 'Final text length:', fullTextSoFar.length, 'Tool call:', toolName || 'none')

			// Call onFinalMessage when stream completes
			if (fullTextSoFar || toolName) {
				const toolCall = toolName ? rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId) : null
				const toolCallObj = toolCall ? { toolCall } : {}
				onFinalMessage({
					fullText: fullTextSoFar,
					fullReasoning: '',
					anthropicReasoning: null,
					...toolCallObj,
				})
			} else {
				console.error('[sendOllamaChat] Stream completed but no text or tool call was received. Chunk count:', chunkCount)
				onError({ message: 'Ollama returned an empty response.', fullError: null })
			}
		})
		.catch((error) => {
			// Provide more detailed error information
			const errorMessage = error instanceof Error ? error.message : String(error)
			const detailedError = error instanceof Error ? error : new Error(String(error))
			console.error('[sendOllamaChat] Error:', errorMessage, 'Full error:', error)

			// If tool calling fails, fall back to OpenAI-compatible endpoint
			// This handles cases where the model doesn't support native tool calling
			if (hasTools && (errorMessage.includes('tool') || errorMessage.includes('function'))) {
				console.debug('[sendOllamaChat] Native tool calling failed, falling back to OpenAI-compatible endpoint')
				return _sendOpenAICompatibleChat({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions: undefined, modelName, _setAborter, providerName: 'ollama', chatMode, separateSystemMessage, overridesOfModel, mcpTools })
			}

			onError({
				message: `Ollama error: ${errorMessage}. Check that Ollama is running and the model "${modelName}" is available.`,
				fullError: detailedError
			})
			return // Explicit return for void function
		})
}


const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo

	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }

	return {
		type: 'function',
		function: {
			name: name,
			// strict: true, // strict mode - https://platform.openai.com/docs/guides/function-calling?api-mode=chat
			description: description,
			parameters: {
				type: 'object',
				properties: params,
				// required: Object.keys(params), // in strict mode, all params are required and additionalProperties is false
				// additionalProperties: false,
			},
		}
	} satisfies OpenAI.Chat.Completions.ChatCompletionTool
}

// Part C: Tool Schema Cache - cache tool schemas to avoid rebuilding on every request
const toolSchemaCacheMap = new Map<string, {
	openAIFormat: OpenAI.Chat.Completions.ChatCompletionTool[] | null;
	timestamp: number;
}>();
const TOOL_SCHEMA_CACHE_TTL = 300_000; // 5 minutes
const TOOL_SCHEMA_CACHE_MAX_SIZE = 50;

function computeToolsetHash(chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, allowedTools: { [key: string]: InternalToolInfo } | undefined): string {
	const toolNames: string[] = [];
	const toolSchemas: string[] = [];
	const mcpServerNames: string[] = [];

	if (allowedTools) {
		for (const toolName in allowedTools) {
			const tool = allowedTools[toolName];
			toolNames.push(tool.name);
			const schemaStr = JSON.stringify({
				name: tool.name,
				description: tool.description,
				params: tool.params,
			});
			toolSchemas.push(schemaStr);
		}
	}

	if (mcpTools) {
		for (const mcpTool of mcpTools) {
			mcpServerNames.push(mcpTool.mcpServerName || '');
			toolNames.push(mcpTool.name);
			const schemaStr = JSON.stringify({
				name: mcpTool.name,
				description: mcpTool.description,
				params: mcpTool.params,
			});
			toolSchemas.push(schemaStr);
		}
	}

	const hashInput = JSON.stringify({
		chatMode,
		toolNames: toolNames.sort(),
		toolSchemas: toolSchemas.sort(),
		mcpServerNames: mcpServerNames.sort(),
	});

	// Simple hash function
	let hash = 0;
	for (let i = 0; i < hashInput.length; i++) {
		const char = hashInput.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return hash.toString(36);
}

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	// Part C: Check cache first
	const hash = computeToolsetHash(chatMode, mcpTools, allowedTools);
	const now = Date.now();
	const cached = toolSchemaCacheMap.get(hash);

	if (cached && (now - cached.timestamp) < TOOL_SCHEMA_CACHE_TTL) {
		return cached.openAIFormat;
	}

	// Build tool schemas (expensive operation)
	const buildStart = performance.now();
	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]))
	}
	const buildMs = performance.now() - buildStart;

	// Log in dev mode if build took significant time
	const isDev = typeof process !== 'undefined' && (process.env.NODE_ENV === 'development' || process.env.DEBUG);
	if (isDev && buildMs > 5) {
		console.debug(`[ToolSchemaCache] Built OpenAI tools in ${buildMs.toFixed(2)}ms`);
	}

	// Cache result
	if (toolSchemaCacheMap.size >= TOOL_SCHEMA_CACHE_MAX_SIZE) {
		// Remove oldest entry
		let oldestKey: string | undefined;
		let oldestTime = Infinity;
		for (const [key, value] of toolSchemaCacheMap.entries()) {
			if (value.timestamp < oldestTime) {
				oldestTime = value.timestamp;
				oldestKey = key;
			}
		}
		if (oldestKey) {
			toolSchemaCacheMap.delete(oldestKey);
		}
	}

	toolSchemaCacheMap.set(hash, {
		openAIFormat: openAITools,
		timestamp: now,
	});

	return openAITools
}


// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	let input: unknown
	try { input = JSON.parse(toolParamsStr) }
	catch (e) { return null }

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock

	if (input === null) return null
	if (typeof input !== 'object') return null

	const rawParams: RawToolParamsObj = input
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true }
}


// ------------ OPENAI-COMPATIBLE ------------


const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, separateSystemMessage, overridesOfModel, mcpTools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here

	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	}

	// tools
	const potentialTools = openAITools(chatMode, mcpTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {}

	// PERFORMANCE: Client creation moved earlier (see openaiPromise above)
	// This allows client to be fetched in parallel with other setup work

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {}
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// Variables for tracking response state
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''
	let toolName = ''
	let toolId = ''
	let toolParamsStr = ''
	let isRetrying = false // Flag to prevent processing streaming chunks during retry

	// Detect if this is a local provider for timeout optimization
	const endpoint = settingsOfProvider[providerName]?.endpoint || ''
	const isLocalChat = checkIsLocalProvider(providerName, endpoint)

	// Performance instrumentation (Step 1)
	const promptBytes = JSON.stringify(messages).length;
	const promptTokensEst = Math.ceil(promptBytes / 4); // Rough estimate: ~4 chars per token
	let perfSpan: LocalLLMPerfSpan | undefined;
	if (isLocalChat) {
		// Extract temperature/top_p from additionalOpenAIPayload if available
		const temperature = (includeInPayload as any)?.temperature;
		const topP = (includeInPayload as any)?.top_p;
		perfSpan = perfSpanTracker.createSpan(
			providerName,
			modelName,
			'chat',
			promptTokensEst,
			promptBytes,
			getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel }) || 4096,
			temperature,
			topP
		);
	}

	// PERFORMANCE: Get client early - for local models this is cached and fast
	// Start client creation immediately, don't wait for other setup
	const openaiPromise = getOpenAICompatibleClient({ providerName, settingsOfProvider, includeInPayload })

	// Optimized streaming handler for local providers (Ollama, vLLM, LM Studio, etc.)
	// Reduces overhead by skipping expensive operations and batching perf tracking
	// Key optimizations:
	// - Shorter timeouts (20s vs 120s for cloud)
	// - Faster first token timeout (10s vs 30s)
	// - Batched token counting (every 10 chunks instead of every chunk)
	// - Immediate onText calls (no batching delay)
	const processStreamingResponseLocal = async (response: any) => {
		_setAborter(() => response.controller.abort())

		const overallTimeout = 20_000 // 20s for local
		const firstTokenTimeout = 10_000 // 10s for first token

		let firstTokenReceived = false
		let tokenCountUpdateCounter = 0 // Batch token counting (only every 10 chunks)

		// Set up overall timeout
		const timeoutId = setTimeout(() => {
			if (fullTextSoFar || fullReasoningSoFar || toolName) {
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
				const toolCallObj = toolCall ? { toolCall } : {}
				onFinalMessage({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					anthropicReasoning: null,
					...toolCallObj
				})
			} else {
				response.controller?.abort()
				onError({
					message: 'Local model timed out. Try a smaller model or use a cloud model for this task.',
					fullError: null
				})
			}
		}, overallTimeout)

		// Set up first token timeout
		const firstTokenTimeoutId = setTimeout(() => {
			if (!firstTokenReceived) {
				response.controller?.abort()
				onError({
					message: 'Local model is too slow (no response after 10s). Try a smaller/faster model or use a cloud model.',
					fullError: null
				})
			}
		}, firstTokenTimeout)

		try {
			for await (const chunk of response) {
				if (isRetrying) {
					clearTimeout(timeoutId)
					clearTimeout(firstTokenTimeoutId)
					return
				}

				// Mark first token received
				if (!firstTokenReceived) {
					firstTokenReceived = true
					clearTimeout(firstTokenTimeoutId)
					if (perfSpan) {
						perfSpanTracker.recordFirstToken(perfSpan);
					}
				}

				// Extract text (optimized - single access)
				const delta = chunk.choices?.[0]?.delta
				const newText = delta?.content ?? ''
				if (newText) {
					fullTextSoFar += newText

					// Batch token counting (only every 10 chunks to reduce overhead)
					if (perfSpan && perfSpan.start_time_ms && (++tokenCountUpdateCounter % 10 === 0)) {
						const tokenCount = Math.ceil(fullTextSoFar.length / 4); // Faster: char-based estimate
						const elapsedMs = Date.now() - perfSpan.start_time_ms;
						perfSpanTracker.recordToken(perfSpan, tokenCount, elapsedMs);
					}
				}

				// Tool call (only process if present)
				const toolCalls = delta?.tool_calls
				if (toolCalls && toolCalls.length > 0) {
					const tool = toolCalls[0]
					if (tool.index === 0) {
						toolName += tool.function?.name ?? ''
						toolParamsStr += tool.function?.arguments ?? ''
						toolId += tool.id ?? ''
					}
				}

				// Reasoning (only if needed)
				if (nameOfReasoningFieldInDelta && delta) {
					// @ts-ignore
					const newReasoning = (delta[nameOfReasoningFieldInDelta] || '') + ''
					if (newReasoning) {
						fullReasoningSoFar += newReasoning
					}
				}

				// Call onText immediately (no batching delay for local models)
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
				})
			}
		} catch (streamError) {
			clearTimeout(timeoutId)
			clearTimeout(firstTokenTimeoutId)
			if (perfSpan) {
				const errorCategory = streamError instanceof Error ? streamError.name : 'Unknown';
				perfSpanTracker.completeSpan(perfSpan, false, errorCategory);
			}
			throw streamError
		}

		clearTimeout(timeoutId)
		clearTimeout(firstTokenTimeoutId)

		if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
			if (perfSpan) {
				perfSpanTracker.completeSpan(perfSpan, false, 'EmptyResponse');
			}
			onError({ message: 'CortexIDE: Response from model was empty.', fullError: null })
		} else {
			if (perfSpan) {
				perfSpanTracker.completeSpan(perfSpan, true);
			}
			const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
			const toolCallObj = toolCall ? { toolCall } : {}
			onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
		}
	}

	// Helper function to process streaming response (for cloud providers)
	const processStreamingResponse = async (response: any) => {
		_setAborter(() => response.controller.abort())

		// For local models, add hard timeout with partial results
		const overallTimeout = isLocalChat ? 20_000 : 120_000 // 20s for local, 120s for remote
		const firstTokenTimeout = isLocalChat ? 10_000 : 30_000 // 10s for first token on local

		let firstTokenReceived = false

		// Set up overall timeout
		const timeoutId = setTimeout(() => {
			if (fullTextSoFar || fullReasoningSoFar || toolName) {
				// We have partial results - commit them
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
				const toolCallObj = toolCall ? { toolCall } : {}
				onFinalMessage({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					anthropicReasoning: null,
					...toolCallObj
				})
				// Note: We don't call onError here since we have partial results
			} else {
				// No tokens received - abort
				response.controller?.abort()
				onError({
					message: isLocalChat
						? 'Local model timed out. Try a smaller model or use a cloud model for this task.'
						: 'Request timed out.',
					fullError: null
				})
			}
		}, overallTimeout)

		// Set up first token timeout (only for local models)
		let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null
		if (isLocalChat) {
			firstTokenTimeoutId = setTimeout(() => {
				if (!firstTokenReceived) {
					response.controller?.abort()
					onError({
						message: 'Local model is too slow (no response after 10s). Try a smaller/faster model or use a cloud model.',
						fullError: null
					})
				}
			}, firstTokenTimeout)
		}

		try {
			// when receive text
			for await (const chunk of response) {
				// Check if we're retrying (another response is being processed)
				if (isRetrying) {
					clearTimeout(timeoutId)
					if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId)
					return // Stop processing this streaming response, retry is in progress
				}

				// Mark first token received
				if (!firstTokenReceived) {
					firstTokenReceived = true
					if (firstTokenTimeoutId) {
						clearTimeout(firstTokenTimeoutId)
						firstTokenTimeoutId = null
					}
					if (perfSpan) {
						perfSpanTracker.recordFirstToken(perfSpan);
					}
				}

				// message
				const newText = chunk.choices[0]?.delta?.content ?? ''
				fullTextSoFar += newText
				if (perfSpan && perfSpan.start_time_ms) {
					const tokenCount = fullTextSoFar.split(/\s+/).length; // Rough token count
					const elapsedMs = Date.now() - perfSpan.start_time_ms;
					perfSpanTracker.recordToken(perfSpan, tokenCount, elapsedMs);
				}

				// tool call
				for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
					const index = tool.index
					if (index !== 0) continue

					toolName += tool.function?.name ?? ''
					toolParamsStr += tool.function?.arguments ?? '';
					toolId += tool.id ?? ''
				}


				// reasoning
				let newReasoning = ''
				if (nameOfReasoningFieldInDelta) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + ''
					fullReasoningSoFar += newReasoning
				}

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
				})

			}

			// Clear timeouts on successful completion
			clearTimeout(timeoutId)
			if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId)

			// on final
			if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
				if (perfSpan) {
					perfSpanTracker.completeSpan(perfSpan, false, 'EmptyResponse');
				}
				onError({ message: 'CortexIDE: Response from model was empty.', fullError: null })
			}
			else {
				if (perfSpan) {
					perfSpanTracker.completeSpan(perfSpan, true);
				}
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
				const toolCallObj = toolCall ? { toolCall } : {}
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		} catch (streamError) {
			clearTimeout(timeoutId)
			if (firstTokenTimeoutId) clearTimeout(firstTokenTimeoutId)
			if (perfSpan) {
				const errorCategory = streamError instanceof Error ? streamError.name : 'Unknown';
				perfSpanTracker.completeSpan(perfSpan, false, errorCategory);
			}
			// If error occurs during streaming, re-throw to be caught by outer catch handler
			throw streamError
		}
	}

	// Helper function to process non-streaming response
	const processNonStreamingResponse = async (response: any) => {
		const choice = response.choices[0]
		if (!choice) {
			onError({ message: 'CortexIDE: Response from model was empty.', fullError: null })
			return
		}

		const fullText = choice.message?.content ?? ''
		const toolCalls = choice.message?.tool_calls ?? []

		if (toolCalls.length > 0) {
			const toolCall = toolCalls[0]
			toolName = toolCall.function?.name ?? ''
			toolParamsStr = toolCall.function?.arguments ?? ''
			toolId = toolCall.id ?? ''
		}

		// Call onText once with full text
		onText({
			fullText: fullText,
			fullReasoning: '',
			toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
		})

		// Call onFinalMessage
		const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
		const toolCallObj = toolCall ? { toolCall } : {}
		onFinalMessage({ fullText: fullText, fullReasoning: '', anthropicReasoning: null, ...toolCallObj });
	}

	// PERFORMANCE: Await client now (it was started in parallel above)
	// For local models, this is cached and returns immediately
	const openai = await openaiPromise
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}

	// Step 4A: Server-side caching (capability-gated)
	// Generate cache key if backend supports it
	const capabilities = getBackendCapabilities(providerName);
	const shouldUseServerSideCache = capabilities.supportsPromptCachingKey() || capabilities.supportsServerSideContextCaching();

	// Extract system message (handle different message types)
	const systemMsg = separateSystemMessage || (() => {
		const sysMsg = messages.find(m => m.role === 'system');
		if (!sysMsg) return undefined;
		// Handle OpenAI/Anthropic messages (have 'content')
		if ('content' in sysMsg && typeof sysMsg.content === 'string') {
			return sysMsg.content;
		}
		return undefined;
	})();

	// Extract content from messages for cache key (handle Gemini's 'parts' vs others' 'content')
	const extractMessageContent = (m: LLMChatMessage): string => {
		if ('parts' in m) {
			// Gemini message - extract text from parts
			const textParts = m.parts.filter((p): p is { text: string } => 'text' in p);
			return textParts.map(p => p.text).join(' ');
		} else if ('content' in m) {
			// OpenAI/Anthropic message
			if (typeof m.content === 'string') {
				return m.content;
			}
			return JSON.stringify(m.content);
		}
		return '';
	};

	const chatCacheKey = shouldUseServerSideCache && systemMsg
		? generateChatCacheKey(
			systemMsg,
			messages.filter(m => m.role !== 'system' && m.role !== 'model').slice(0, 2).map(m => ({
				role: m.role,
				content: extractMessageContent(m)
			})),
			modelName
		)
		: undefined;

	// Try streaming first
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: messages as any,
		stream: true,
		...nativeToolsObj,
		...additionalOpenAIPayload
		// max_completion_tokens: maxTokens,
	};

	// Part F: Add cache key if supported (vLLM and some other backends support this)
	// vLLM prefix caching: Reuses KV cache for identical prompt prefixes, significantly speeding up tool turns
	// Best practices (from vLLM docs):
	// - Cache key should be stable for identical prefixes (system message + first few messages)
	// - Different models need different cache keys (tokenization differs)
	// - Cache is automatically managed by vLLM (LRU eviction)
	if (chatCacheKey && shouldUseServerSideCache) {
		// vLLM supports cache_config parameter for prefix caching
		// Format: { "cache_config": { "prompt_cache_key": cacheKey } }
		// This enables prefix caching which can speed up tool turns by 2-5x when system message is unchanged
		(options as any).extra_body = {
			cache_config: {
				prompt_cache_key: chatCacheKey,
			},
		};
	}

	// Flag to ensure we only process one response (prevent duplicate processing)
	// Use object reference to ensure atomic updates across async operations
	const processingState = { responseProcessed: false, isProcessing: false }
	let streamingResponse: any = null

	// PERFORMANCE: Start request immediately - don't wait for any other setup
	// The .create() call sends the HTTP request immediately
	// Use optimized handler for local providers (Ollama, vLLM, LM Studio) for better performance
	// This handler has shorter timeouts, batched token counting, and immediate onText calls
	// Note: vLLM and LM Studio only have OpenAI-compatible APIs (no native SDK), so they're already using the fastest path
	// Ollama has a native SDK which is used for normal/gather modes, but agent mode uses OpenAI-compatible endpoint
	// (unless native tool calling is supported, which we now try first)
	const useOptimizedLocalHandler = isLocalChat && (providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio')
	if (useOptimizedLocalHandler) {
		console.debug(`[${providerName}] Using optimized local handler for faster performance (shorter timeouts, batched token counting)`)
	}
	const streamingHandler = useOptimizedLocalHandler ? processStreamingResponseLocal : processStreamingResponse

	openai.chat.completions
		.create(options)
		.then(async response => {
			// Atomic check-and-set to prevent race conditions
			if (processingState.responseProcessed || processingState.isProcessing || isRetrying) {
				return // Guard against duplicate processing
			}
			processingState.isProcessing = true
			streamingResponse = response
			try {
				await streamingHandler(response)
				processingState.responseProcessed = true
			} finally {
				processingState.isProcessing = false
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(async error => {
			// Abort streaming response if it's still running
			if (streamingResponse) {
				try {
					streamingResponse.controller?.abort()
				} catch (e) {
					// Ignore abort errors
				}
			}

			// Check if this is the organization verification error for streaming
			if (error instanceof OpenAI.APIError &&
				error.status === 400 &&
				error.code === 'unsupported_value' &&
				error.param === 'stream' &&
				error.message?.includes('organization must be verified')) {

				// Set retry flag to stop processing any remaining streaming chunks
				isRetrying = true

				// Reset state variables before retrying to prevent duplicate content
				fullTextSoFar = ''
				fullReasoningSoFar = ''
				toolName = ''
				toolId = ''
				toolParamsStr = ''

				// Retry with streaming disabled (only retry the API call, not the entire message flow)
				// Silently retry - don't show error notification for organization verification issues
				const nonStreamingOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
					model: modelName,
					messages: messages as any,
					stream: false,
					...nativeToolsObj,
					...additionalOpenAIPayload
				};

				// Add cache key if supported (same as streaming options)
				if (chatCacheKey && shouldUseServerSideCache) {
					(nonStreamingOptions as any).extra_body = {
						cache_config: {
							prompt_cache_key: chatCacheKey,
						},
					};
				}

				try {
					const response = await openai.chat.completions.create(nonStreamingOptions)
					// Atomic check-and-set to prevent race conditions
					if (processingState.responseProcessed || processingState.isProcessing || !isRetrying) {
						return // Guard against duplicate processing
					}
					processingState.isProcessing = true
					try {
						await processNonStreamingResponse(response)
						processingState.responseProcessed = true
					} finally {
						processingState.isProcessing = false
					}
					isRetrying = false
					// Successfully retried with non-streaming - silently continue, no error notification
					return // Exit early to prevent showing any error
				} catch (retryError) {
					// Log the retry failure for debugging (but don't show confusing error to user)
					console.debug('[sendLLMMessage] Retry with non-streaming also failed:', retryError instanceof Error ? retryError.message : String(retryError))
					// If retry also fails, show a generic error instead of silently failing
					// This prevents users from wondering why the model isn't responding
					onError({
						message: 'Failed to get response from model. Please check your API key and organization settings.',
						fullError: retryError instanceof Error ? retryError : new Error(String(retryError))
					})
					return
				}
			}
			// Check if this is a "model does not support tools" error (e.g., from Ollama)
			else if (error instanceof OpenAI.APIError &&
				error.status === 400 &&
				(error.message?.toLowerCase().includes('does not support tools') ||
					error.message?.toLowerCase().includes('tool') && error.message?.toLowerCase().includes('not support'))) {

				// Set retry flag to stop processing any remaining streaming chunks
				isRetrying = true

				// Reset state variables before retrying to prevent duplicate content
				fullTextSoFar = ''
				fullReasoningSoFar = ''
				toolName = ''
				toolId = ''
				toolParamsStr = ''

				// Retry without tools - this model doesn't support native tool calling
				// Fall back to XML-based tool calling or regular chat
				// CRITICAL: Retry immediately without delay for tool support errors (they're fast to detect)
				const optionsWithoutTools: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
					model: modelName,
					messages: messages as any,
					stream: true,
					// Explicitly omit tools - don't include nativeToolsObj
					...additionalOpenAIPayload
				};

				// Add cache key if supported (same as original options)
				if (chatCacheKey && shouldUseServerSideCache) {
					(optionsWithoutTools as any).extra_body = {
						cache_config: {
							prompt_cache_key: chatCacheKey,
						},
					};
				}

				try {
					// Use same timeout as original request (already optimized for local models)
					const response = await openai.chat.completions.create(optionsWithoutTools)
					// Atomic check-and-set to prevent race conditions
					if (processingState.responseProcessed || processingState.isProcessing || !isRetrying) {
						return // Guard against duplicate processing
					}
					processingState.isProcessing = true
					streamingResponse = response
					try {
						await streamingHandler(response)
						processingState.responseProcessed = true
					} finally {
						processingState.isProcessing = false
					}
					isRetrying = false
					// Successfully retried without tools - silently continue
					// Note: XML-based tool calling will still work if the model supports it
					return // Exit early to prevent showing any error
				} catch (retryError) {
					// Log the retry failure for debugging
					console.debug('[sendLLMMessage] Retry without tools also failed:', retryError instanceof Error ? retryError.message : String(retryError))
					// If retry also fails, show the original error
					onError({
						message: `Model does not support tool calling: ${error.message || 'Unknown error'}`,
						fullError: retryError instanceof Error ? retryError : new Error(String(retryError))
					})
					return
				}
			}
			else if (error instanceof OpenAI.APIError && error.status === 401) {
				if (perfSpan) {
					perfSpanTracker.completeSpan(perfSpan, false, 'APIError_401');
				}
				onError({ message: invalidApiKeyMessage(providerName), fullError: error });
			}
			else if (error instanceof OpenAI.APIError && error.status === 429) {
				// Rate limit exceeded - don't retry immediately, show clear error
				if (perfSpan) {
					perfSpanTracker.completeSpan(perfSpan, false, 'APIError_429');
				}
				const rateLimitMessage = error.message || 'Rate limit exceeded. Please wait a moment before trying again.';
				onError({ message: `Rate limit exceeded: ${rateLimitMessage}`, fullError: error });
			}
			else {
				if (perfSpan) {
					const errorCategory = error instanceof OpenAI.APIError ? `APIError_${error.status}` : 'Unknown';
					perfSpanTracker.completeSpan(perfSpan, false, errorCategory);
				}
				onError({ message: error + '', fullError: error });
			}
		})
}



type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
}
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const openai = await getOpenAICompatibleClient({ providerName, settingsOfProvider })
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = []
				models.push(...response.data)
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data)
				}
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {}
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' } }
	return {
		name: name,
		description: description,
		input_schema: {
			type: 'object',
			properties: paramsWithType,
			// required: Object.keys(params),
		},
	} satisfies Anthropic.Messages.Tool
}

const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null

	const anthropicTools: Anthropic.Messages.ToolUnion[] = []
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]))
	}
	return anthropicTools
}



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, mcpTools }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	const thisConfig = settingsOfProvider.anthropic
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel })

	// tools
	const potentialTools = anthropicTools(chatMode, mcpTools)
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {}


	// instance
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true,
		timeout: 60_000, // 60s timeout
		maxRetries: 2, // Fast retries for transient errors
		// Connection reuse is handled internally by the SDK
	});

	const stream = anthropic.messages.stream({
		system: separateSystemMessage ?? undefined,
		messages: messages as any, // AnthropicLLMChatMessage type may not exactly match SDK's MessageParam, but is compatible at runtime
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	})

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullText = ''
	let fullReasoning = ''

	let fullToolName = ''
	let fullToolParams = ''


	const runOnText = () => {
		onText({
			fullText,
			fullReasoning,
			toolCall: !fullToolName ? undefined : { name: fullToolName, rawParams: {}, isDone: false, doneParams: [], id: 'dummy' },
		})
	}
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) fullText += '\n\n' // starting a 2nd text block
				fullText += e.content_block.text
				runOnText()
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking
				runOnText()
			}
			else if (e.content_block.type === 'redacted_thinking') {
				console.log('delta', e.content_block.type)
				if (fullReasoning) fullReasoning += '\n\n' // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]'
				runOnText()
			}
			else if (e.content_block.type === 'tool_use') {
				fullToolName += e.content_block.name ?? '' // anthropic gives us the tool name in the start block
				runOnText()
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text
				runOnText()
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking
				runOnText()
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				fullToolParams += e.delta.partial_json ?? '' // anthropic gives us the partial delta (string) here - https://docs.anthropic.com/en/api/messages-streaming
				runOnText()
			}
		}
	})

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking')
		const tools = response.content.filter(c => c.type === 'tool_use')
		// console.log('TOOLS!!!!!!', JSON.stringify(tools, null, 2))
		// console.log('TOOLS!!!!!!', JSON.stringify(response, null, 2))
		const toolCall = tools[0] && rawToolCallObjOfAnthropicParams(tools[0])
		const toolCallObj = toolCall ? { toolCall } : {}

		onFinalMessage({ fullText, fullReasoning, anthropicReasoning, ...toolCallObj })
	})
	// on error
	stream.on('error', (error) => {
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }) }
		else { onError({ message: error + '', fullError: error }) }
	})
	_setAborter(() => stream.controller.abort())
}



// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel)
	if (!supportsFIM) {
		if (modelName === modelName_)
			onError({ message: `Model ${modelName} does not support FIM.`, fullError: null })
		else
			onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null })
		return
	}

	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey })
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			let content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('')

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		})
}


// ------------ OLLAMA ------------

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models })
	}
	const onError = ({ error }: { error: string }) => {
		onError_({ error })
	}
	try {
		const thisConfig = settingsOfProvider.ollama
		const ollama = getOllamaClient({ endpoint: thisConfig.endpoint })
		ollama.list()
			.then((response) => {
				const { models } = response
				onSuccess({ models })
			})
			.catch((error) => {
				onError({ error: error + '' })
			})
	}
	catch (error) {
		onError({ error: error + '' })
	}
}

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo
	return {
		name,
		description,
		parameters: {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {} as Record<string, Schema>)
		}
	} satisfies FunctionDeclaration
}

const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined): GeminiTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools)
	if (!allowedTools || Object.keys(allowedTools).length === 0) return null
	const functionDecls: FunctionDeclaration[] = []
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]))
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, }
	return [tools]
}



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	mcpTools,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') throw new Error(`Sending Gemini chat, but provider was ${providerName}`)

	const thisConfig = settingsOfProvider[providerName]

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel)

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel) // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools)
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined

	// instance
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools)
		onText = newOnText
		onFinalMessage = newOnFinalMessage
	}

	// when receive text
	let fullReasoningSoFar = ''
	let fullTextSoFar = ''

	let toolName = ''
	let toolParamsStr = ''
	let toolId = ''


	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });

			// Process the stream
			for await (const chunk of stream) {
				// message
				const newText = chunk.text ?? ''
				fullTextSoFar += newText

				// tool call
				const functionCalls = chunk.functionCalls
				if (functionCalls && functionCalls.length > 0) {
					const functionCall = functionCalls[0] // Get the first function call
					toolName = functionCall.name ?? ''
					toolParamsStr = JSON.stringify(functionCall.args ?? {})
					toolId = functionCall.id ?? ''
				}

				// (do not handle reasoning yet)

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
				})
			}

			// on final
			if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
				onError({ message: 'CortexIDE: Response from model was empty.', fullError: null })
			} else {
				if (!toolId) toolId = generateUuid() // ids are empty, but other providers might expect an id
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId)
				const toolCallObj = toolCall ? { toolCall } : {}
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		})
		.catch(error => {
			const message = error?.message
			if (typeof message === 'string') {

				if (error.message?.includes('API key')) {
					onError({ message: invalidApiKeyMessage(providerName), fullError: error });
				}
				else if (error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED') || error?.message?.includes('quota')) {
					// Parse Gemini rate limit error to extract user-friendly message
					let rateLimitMessage = 'Rate limit reached. Please check your plan and billing details.';
					let retryDelay: string | undefined;

					try {
						// Try to parse the error message which may contain JSON
						let errorData: any = null;

						// First, try to parse the error message as JSON (it might be a JSON string)
						try {
							errorData = JSON.parse(error.message);
						} catch {
							// If that fails, check if error.message contains a JSON string
							const jsonMatch = error.message.match(/\{[\s\S]*\}/);
							if (jsonMatch) {
								errorData = JSON.parse(jsonMatch[0]);
							}
						}

						// Extract user-friendly message from nested structure
						if (errorData?.error?.message) {
							// The message might itself be a JSON string
							try {
								const innerError = JSON.parse(errorData.error.message);
								if (innerError?.error?.message) {
									rateLimitMessage = innerError.error.message;
									// Extract retry delay if available
									const retryInfo = innerError.error.details?.find((d: any) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
									if (retryInfo?.retryDelay) {
										retryDelay = retryInfo.retryDelay;
									}
								}
							} catch {
								// If inner parse fails, use the outer message
								rateLimitMessage = errorData.error.message;
							}
						} else if (errorData?.error?.code === 429 || errorData?.error?.status === 'RESOURCE_EXHAUSTED') {
							// Fallback: use a generic rate limit message
							rateLimitMessage = 'You exceeded your current quota. Please check your plan and billing details.';
						}

						// Format the final message
						let finalMessage = rateLimitMessage;
						if (retryDelay) {
							// Parse retry delay (format: "57s" or "57.627694635s")
							const delaySeconds = parseFloat(retryDelay.replace('s', ''));
							const delayMinutes = Math.floor(delaySeconds / 60);
							const remainingSeconds = Math.ceil(delaySeconds % 60);
							if (delayMinutes > 0) {
								finalMessage += ` Please retry in ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''}${remainingSeconds > 0 ? ` and ${remainingSeconds} second${remainingSeconds > 1 ? 's' : ''}` : ''}.`;
							} else {
								finalMessage += ` Please retry in ${Math.ceil(delaySeconds)} second${Math.ceil(delaySeconds) > 1 ? 's' : ''}.`;
							}
						} else {
							finalMessage += ' Please wait a moment before trying again.';
						}

						// Add helpful links
						finalMessage += ' For more information, see https://ai.google.dev/gemini-api/docs/rate-limits';

						onError({ message: finalMessage, fullError: error });
					} catch (parseError) {
						// If parsing fails, use a generic message
						onError({ message: 'Rate limit reached. Please check your Gemini API quota and billing details. See https://ai.google.dev/gemini-api/docs/rate-limits', fullError: error });
					}
				}
				else
					onError({ message: error + '', fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		})
};



type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: ListParams_Internal<any>) => void) | null;
	}
}

export const sendLLMMessageToProviderImplementation = {
	anthropic: {
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	xAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => sendOllamaChat(params), // Use native Ollama SDK for chat (much faster than OpenAI-compatible endpoint)
		sendFIM: (params) => sendOllamaFIM(params), // Match Void: Use native Ollama SDK for FIM (better compatibility)
		list: ollamaList,
	},
	openAICompatible: {
		sendChat: (params) => _sendOpenAICompatibleChat(params), // using openai's SDK is not ideal (your implementation might not do tools, reasoning, FIM etc correctly), talk to us for a custom integration
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	vLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	groq: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

	lmStudio: {
		// lmStudio has no suffix parameter in /completions, so sendFIM might not work
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<｜fim▁begin｜>{{ .Prompt }}<｜fim▁hole｜>{{ .Suffix }}<｜fim▁end｜>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
