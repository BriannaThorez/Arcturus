/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProviderName, localProviderNames } from './cortexideSettingsTypes.js';

/**
 * Check if a provider is a local provider based on provider name and endpoint
 */
export function isLocalProvider(providerName: ProviderName, endpoint: string): boolean {
	// Check if provider name is in the local providers list
	if ((localProviderNames as readonly string[]).includes(providerName)) {
		return true;
	}

	// For openAICompatible and liteLLM, check if endpoint is localhost
	if (providerName === 'openAICompatible' || providerName === 'liteLLM') {
		const lowerEndpoint = endpoint.toLowerCase();
		return lowerEndpoint.includes('localhost') ||
			lowerEndpoint.includes('127.0.0.1') ||
			lowerEndpoint.startsWith('http://localhost') ||
			lowerEndpoint.startsWith('http://127.0.0.1') ||
			lowerEndpoint.startsWith('http://0.0.0.0');
	}

	return false;
}

export interface BackendCapabilities {
	supportsPromptCachingKey(): boolean;
	supportsServerSideContextCaching(): boolean;
}

class BackendCapabilitiesImpl implements BackendCapabilities {
	constructor(private readonly providerName: ProviderName) {}

	supportsPromptCachingKey(): boolean {
		// vLLM and some other local backends support prompt caching
		return this.providerName === 'vLLM' ||
			this.providerName === 'openAICompatible' ||
			this.providerName === 'liteLLM';
	}

	supportsServerSideContextCaching(): boolean {
		// Some backends support server-side context caching
		return this.providerName === 'vLLM' ||
			this.providerName === 'openAICompatible' ||
			this.providerName === 'liteLLM';
	}
}

/**
 * Get backend capabilities for a given provider
 */
export function getBackendCapabilities(providerName: ProviderName): BackendCapabilities {
	return new BackendCapabilitiesImpl(providerName);
}

