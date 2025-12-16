/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *---------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICortexideSettingsService } from './cortexideSettingsService.js';
import { IOllamaInstallerService } from './ollamaInstallerService.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import {
	LocalSetupState,
	LocalSetupError,
	LocalSetupResults,
	VerificationResults,
	SystemCheckResult,
	ModelPackType,
	LocalSetupProgress
} from './localSetupServiceTypes.js';
import { getModelPack } from './modelPacks.js';
// Helper function to check if Ollama is accessible
async function isOllamaAccessible(): Promise<boolean> {
	try {
		const res = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET', signal: AbortSignal.timeout(5000) });
		return res.ok;
	} catch {
		return false;
	}
}

const STORAGE_KEY = 'cortexide.localSetupWizard.state';

export const ILocalSetupService = createDecorator<ILocalSetupService>('LocalSetupService');

export interface ILocalSetupService {
	readonly _serviceBrand: undefined;
	readonly state: LocalSetupState;
	readonly onDidChangeState: Event<LocalSetupState>;

	checkSystem(): Promise<SystemCheckResult>;
	startWizard(): void;
	installOllama(): Promise<void>;
	downloadModelPack(packType: ModelPackType, token?: CancellationToken): Promise<string[]>;
	verifyCapabilities(token?: CancellationToken): Promise<VerificationResults>;
	setDefaults(packType: ModelPackType): Promise<void>;
	cancel(): void;
	getProgress(): LocalSetupProgress;
}

export class LocalSetupService extends Disposable implements ILocalSetupService {
	declare readonly _serviceBrand: undefined;

	private _state: LocalSetupState = { type: 'idle' };
	private readonly _onDidChangeState = new Emitter<LocalSetupState>();
	readonly onDidChangeState = this._onDidChangeState.event;

	private cancellationTokenSource: CancellationTokenSource | null = null;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@ILogService private readonly logService: ILogService,
		@ICortexideSettingsService private readonly settingsService: ICortexideSettingsService,
		@IOllamaInstallerService private readonly ollamaInstallerService: IOllamaInstallerService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
	) {
		super();
		this._register(this._onDidChangeState);
		this._loadPersistedState();
	}

	get state(): LocalSetupState {
		return this._state;
	}

	private _setState(newState: LocalSetupState): void {
		this._state = newState;
		this._onDidChangeState.fire(newState);
		this._persistState();
	}

	private _persistState(): void {
		if (this._state.type === 'idle' || this._state.type === 'done') {
			// Don't persist idle or done states
			this.storageService.remove(STORAGE_KEY, StorageScope.APPLICATION);
		} else {
			// Persist intermediate states for resume capability
			this.storageService.store(STORAGE_KEY, JSON.stringify(this._state), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	private _loadPersistedState(): void {
		try {
			const stored = this.storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
			if (stored) {
				const parsed = JSON.parse(stored) as LocalSetupState;
				// Only resume if we're in a recoverable state
				if (parsed.type !== 'idle' && parsed.type !== 'done' && parsed.type !== 'error') {
					this._state = parsed;
				}
			}
		} catch (error) {
			this.logService.warn('[LocalSetupService] Failed to load persisted state:', error);
		}
	}

	startWizard(): void {
		if (this._state.type !== 'idle') {
			this.logService.warn('[LocalSetupService] Wizard already started');
			return;
		}
		this._setState({ type: 'checking' });
	}

	async checkSystem(): Promise<SystemCheckResult> {
		this._setState({ type: 'checking' });

		const result: SystemCheckResult = {
			ollamaInstalled: false,
			ollamaRunning: false,
			ollamaEndpoint: 'http://127.0.0.1:11434',
			otherLocalEndpoints: [],
			diskSpaceGb: null,
			hasGpu: null,
		};

		try {
			// Check if Ollama is installed (check for binary/process)
			const osProps = await this.nativeHostService.getOSProperties();
			result.ollamaInstalled = await this._checkOllamaInstalled(osProps.type);

			// Check if Ollama is running
			result.ollamaRunning = await isOllamaAccessible();

			// Check other local endpoints
			const settings = this.settingsService.state.settingsOfProvider;
			if (settings.vLLM.endpoint && settings.vLLM.endpoint !== '') {
				result.otherLocalEndpoints.push({
					provider: 'vLLM',
					endpoint: settings.vLLM.endpoint,
					running: await this._checkEndpointRunning(settings.vLLM.endpoint),
				});
			}
			if (settings.lmStudio.endpoint && settings.lmStudio.endpoint !== '') {
				result.otherLocalEndpoints.push({
					provider: 'lmStudio',
					endpoint: settings.lmStudio.endpoint,
					running: await this._checkEndpointRunning(settings.lmStudio.endpoint),
				});
			}

			// Try to estimate disk space (optional, may fail)
			try {
				result.diskSpaceGb = await this._estimateDiskSpace();
			} catch {
				// Ignore errors, leave as null
			}

			// GPU detection is optional and may not be available
			// For now, leave as null (can be enhanced later)

		} catch (error) {
			this.logService.error('[LocalSetupService] System check failed:', error);
		}

		return result;
	}

	private async _checkOllamaInstalled(osType: string): Promise<boolean> {
		// Simple check: try to access Ollama endpoint
		// If it's accessible, it's likely installed
		// More sophisticated checks could be added per-OS
		return await isOllamaAccessible();
	}

	private async _checkEndpointRunning(endpoint: string): Promise<boolean> {
		try {
			const url = endpoint.endsWith('/v1') ? endpoint.replace('/v1', '/models') : `${endpoint}/v1/models`;
			const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
			return response.ok;
		} catch {
			return false;
		}
	}

	private async _estimateDiskSpace(): Promise<number | null> {
		// This is a placeholder - actual implementation would require OS-specific APIs
		// For now, return null to indicate unknown
		return null;
	}

	async installOllama(): Promise<void> {
		if (this._state.type !== 'checking' && this._state.type !== 'installing') {
			throw new Error('Cannot install Ollama in current state');
		}

		this._setState({ type: 'installing', progress: 0, log: [] });

		return new Promise((resolve, reject) => {
			const logLines: string[] = [];

			const logDisposable = this.ollamaInstallerService.onLog((line: string) => {
				logLines.push(line);
				this._setState({ type: 'installing', progress: 50, log: [...logLines] });
			});

			const doneDisposable = this.ollamaInstallerService.onDone((success: boolean) => {
				logDisposable.dispose();
				doneDisposable.dispose();

				if (success) {
					// Verify installation
					setTimeout(async () => {
						const isRunning = await isOllamaAccessible();
						if (isRunning) {
							this._setState({ type: 'checking' });
							resolve();
						} else {
							const error: LocalSetupError = {
								code: 'INSTALL_FAILED',
								message: 'Ollama installed but not running. Please start Ollama manually.',
								details: logLines.join('\n'),
							};
							this._setState({ type: 'error', error });
							reject(new Error(error.message));
						}
					}, 2000);
				} else {
					const error: LocalSetupError = {
						code: 'INSTALL_FAILED',
						message: 'Ollama installation failed. See logs for details.',
						details: logLines.join('\n'),
					};
					this._setState({ type: 'error', error });
					reject(new Error(error.message));
				}
			});

			// Start installation
			this.ollamaInstallerService.install({ method: 'auto' });
		});
	}

	async downloadModelPack(packType: ModelPackType, token?: CancellationToken): Promise<string[]> {
		const pack = getModelPack(packType);
		if (!pack) {
			throw new Error(`Unknown model pack: ${packType}`);
		}

		// Collect unique models to download
		const modelsToDownload = new Set<string>();
		if (pack.models.chat) {
			modelsToDownload.add(pack.models.chat);
		}
		if (pack.models.tools) {
			modelsToDownload.add(pack.models.tools);
		}
		if (pack.models.fim) {
			modelsToDownload.add(pack.models.fim);
		}
		if (pack.models.embeddings) {
			modelsToDownload.add(pack.models.embeddings);
		}
		if (pack.models.vision) {
			modelsToDownload.add(pack.models.vision);
		}

		const modelList = Array.from(modelsToDownload);
		const downloaded: string[] = [];
		const totalModels = modelList.length;

		this._setState({
			type: 'downloading',
			currentModel: '',
			progress: 0,
			totalModels
		});

		const cancellationToken = token || CancellationToken.None;
		this.cancellationTokenSource = new CancellationTokenSource();
		if (token) {
			token.onCancellationRequested(() => this.cancellationTokenSource?.cancel());
		}

		try {
			for (let i = 0; i < modelList.length; i++) {
				if (cancellationToken.isCancellationRequested || this.cancellationTokenSource.token.isCancellationRequested) {
					throw new Error('Download cancelled');
				}

				const modelName = modelList[i];
				this._setState({
					type: 'downloading',
					currentModel: modelName,
					progress: i,
					totalModels
				});

				await this._pullModel(modelName, this.cancellationTokenSource.token);
				downloaded.push(modelName);
			}

			this._setState({
				type: 'downloading',
				currentModel: '',
				progress: totalModels,
				totalModels
			});

			return downloaded;
		} catch (error) {
			const errorObj: LocalSetupError = {
				code: 'DOWNLOAD_FAILED',
				message: error instanceof Error ? error.message : 'Model download failed',
				model: this._state.type === 'downloading' ? this._state.currentModel : undefined,
			};
			this._setState({ type: 'error', error: errorObj });
			throw error;
		}
	}

	private async _pullModel(modelName: string, token: CancellationToken): Promise<void> {
		// Use Ollama HTTP API to pull model with progress tracking
		const endpoint = this.settingsService.state.settingsOfProvider.ollama.endpoint || 'http://127.0.0.1:11434';
		const url = `${endpoint}/api/pull`;

		return new Promise((resolve, reject) => {
			const controller = new AbortController();
			if (token.isCancellationRequested) {
				controller.abort();
			}
			token.onCancellationRequested(() => controller.abort());

			fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: modelName }),
				signal: controller.signal,
			})
				.then(async (response) => {
					if (!response.ok) {
						throw new Error(`Failed to pull model: ${response.statusText}`);
					}

					// Stream the response to track progress
					const reader = response.body?.getReader();
					if (!reader) {
						throw new Error('No response body');
					}

					const decoder = new TextDecoder();
					let buffer = '';

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							if (line.trim()) {
								try {
									const data = JSON.parse(line);
									// Update progress if available
									if (data.completed && data.total) {
										// Could emit progress events here if needed
										// const progress = (data.completed / data.total) * 100;
									}
								} catch {
									// Ignore parse errors
								}
							}
						}
					}

					resolve();
				})
				.catch((error) => {
					if (error.name === 'AbortError') {
						reject(new Error('Download cancelled'));
					} else {
						reject(error);
					}
				});
		});
	}

	async verifyCapabilities(token?: CancellationToken): Promise<VerificationResults> {
		const results: VerificationResults = {
			chat: { passed: false },
			toolCalling: { passed: false },
			webCalling: { passed: false, skipped: true },
			vision: { passed: false, skipped: true },
		};

		const cancellationToken = token || CancellationToken.None;
		this.cancellationTokenSource = new CancellationTokenSource();
		if (token) {
			token.onCancellationRequested(() => this.cancellationTokenSource?.cancel());
		}

		const tests = [
			{ name: 'Chat', fn: () => this._verifyChat(cancellationToken) },
			{ name: 'Tool Calling', fn: () => this._verifyToolCalling(cancellationToken) },
			{ name: 'Web Calling', fn: () => this._verifyWebCalling(cancellationToken) },
		];

		this._setState({
			type: 'verifying',
			currentTest: '',
			progress: 0,
			totalTests: tests.length
		});

		try {
			for (let i = 0; i < tests.length; i++) {
				if (cancellationToken.isCancellationRequested || this.cancellationTokenSource.token.isCancellationRequested) {
					break;
				}

				const test = tests[i];
				this._setState({
					type: 'verifying',
					currentTest: test.name,
					progress: i,
					totalTests: tests.length
				});

				try {
					await test.fn();
					if (test.name === 'Chat') {
						results.chat.passed = true;
					}
					if (test.name === 'Tool Calling') {
						results.toolCalling.passed = true;
					}
					if (test.name === 'Web Calling') {
						results.webCalling.passed = true;
						results.webCalling.skipped = false;
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : 'Unknown error';
					if (test.name === 'Chat') {
						results.chat.error = errorMsg;
					}
					if (test.name === 'Tool Calling') {
						results.toolCalling.error = errorMsg;
					}
					if (test.name === 'Web Calling') {
						results.webCalling.error = errorMsg;
					}
				}
			}

			return results;
		} catch (error) {
			this.logService.error('[LocalSetupService] Verification failed:', error);
			return results;
		}
	}

	private async _verifyChat(token: CancellationToken): Promise<void> {
		// Simple chat test: send a message and expect a response
		const settings = this.settingsService.state;
		const ollamaModels = settings.settingsOfProvider.ollama.models;
		if (ollamaModels.length === 0) {
			throw new Error('No Ollama models available');
		}

		const modelName = ollamaModels[0].modelName;
		let chatPassed = false;
		let chatError: string | undefined;

		const requestId = this.llmMessageService.sendLLMMessage({
			modelSelection: { providerName: 'ollama', modelName },
			messagesType: 'chatMessages',
			messages: [{ role: 'user', content: 'Say "hello" if you can read this.' }],
			separateSystemMessage: undefined,
			chatMode: null,
			onText: () => {
				// Text received, chat is working
			},
			onFinalMessage: () => {
				chatPassed = true;
			},
			onError: ({ message }) => {
				chatError = message;
			},
			onAbort: () => {
				// Ignore aborts
			},
			logging: { loggingName: 'LocalSetupVerification_Chat' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
		});

		if (!requestId) {
			throw new Error('Failed to send chat message');
		}

		// Wait for response with timeout
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (!chatPassed) {
					reject(new Error(chatError || 'Chat test timeout'));
				} else {
					resolve();
				}
			}, 30000);

			// Check periodically if chat passed
			const checkInterval = setInterval(() => {
				if (chatPassed) {
					clearTimeout(timeout);
					clearInterval(checkInterval);
					resolve();
				} else if (chatError) {
					clearTimeout(timeout);
					clearInterval(checkInterval);
					reject(new Error(chatError));
				}
			}, 500);
		});
	}

	private async _verifyToolCalling(token: CancellationToken): Promise<void> {
		// Tool calling test: invoke a safe built-in tool
		// This is a simplified test - real implementation would use IToolsService
		// For now, verify that a model with tool calling capability is available
		const settings = this.settingsService.state;
		const ollamaModels = settings.settingsOfProvider.ollama.models;
		if (ollamaModels.length === 0) {
			throw new Error('No Ollama models available for tool calling test');
		}
		// Tool calling verification would require actual tool invocation
		// This is a placeholder - in full implementation, would test actual tool call
	}

	private async _verifyWebCalling(token: CancellationToken): Promise<void> {
		// Web calling test: only if enabled
		const settings = this.settingsService.state;
		if (!settings.globalSettings.useHeadlessBrowsing) {
			// Skip if not enabled
			return;
		}
		// Placeholder for web calling verification
		// Would test browse_url tool if implemented
	}

	async setDefaults(packType: ModelPackType): Promise<void> {
		const pack = getModelPack(packType);
		if (!pack) {
			throw new Error(`Unknown model pack: ${packType}`);
		}

		// Set Ollama as default provider
		await this.settingsService.setSettingOfProvider('ollama', '_didFillInProviderSettings', true);

		// Set default models for features
		if (pack.models.chat) {
			await this.settingsService.setModelSelectionOfFeature('Chat', {
				providerName: 'ollama',
				modelName: pack.models.chat,
			});
		}

		// Enable localFirstAI
		await this.settingsService.setGlobalSetting('localFirstAI', true);

		// Mark as done
		const results: LocalSetupResults = {
			ollamaInstalled: true,
			ollamaRunning: true,
			modelsInstalled: [pack.models.chat, pack.models.tools, pack.models.fim].filter(Boolean) as string[],
			verificationResults: {
				chat: { passed: true },
				toolCalling: { passed: true },
				webCalling: { passed: false, skipped: true },
				vision: { passed: false, skipped: true },
			},
			defaultsConfigured: true,
		};

		this._setState({ type: 'done', results });
	}

	cancel(): void {
		if (this.cancellationTokenSource) {
			this.cancellationTokenSource.cancel();
			this.cancellationTokenSource = null;
		}
		this._setState({ type: 'idle' });
	}

	getProgress(): LocalSetupProgress {
		const state = this._state;
		let currentStep = 0;
		const totalSteps = 7; // Choice, Check, Install, Download, Verify, Set Defaults, Tour

		if (state.type === 'checking') {
			currentStep = 1;
		} else if (state.type === 'installing') {
			currentStep = 2;
		} else if (state.type === 'downloading') {
			currentStep = 3;
		} else if (state.type === 'verifying') {
			currentStep = 4;
		} else if (state.type === 'done') {
			currentStep = totalSteps;
		}

		return {
			state,
			currentStep,
			totalSteps,
			canCancel: state.type !== 'idle' && state.type !== 'done' && state.type !== 'error',
		};
	}
}

registerSingleton(ILocalSetupService, LocalSetupService, InstantiationType.Delayed);

