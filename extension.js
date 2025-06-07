// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const fs = require('fs'); // Import the 'fs' module

// Constants for workspace state keys
const OLLAMA_PARTIAL_RESPONSE = 'ollamaPartialResponse';
const OLLAMA_CHAT_HISTORY = 'ollamaChatHistory';
const OLLAMA_SELECTED_MODEL = 'ollamaSelectedModel';
const VSWIZARD_SESSIONS = 'vswizardSessions';
const VSWIZARD_CURRENT_SESSION_ID = 'vswizardCurrentSessionId';

// Add new constants for OpenAI
const OPENAI_API_KEY = 'openaiApiKey';
const OPENAI_API_ENDPOINT = 'openaiApiEndpoint';
const OPENAI_SELECTED_MODEL = 'openaiSelectedModel';
const OPENAI_TEMPERATURE = 'openaiTemperature';
const VSWIZARD_PROVIDER = 'vswizardProvider'; // 'ollama' or 'openai'

// Add a constant for the default OpenAI model
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
let chatViewProviderInstance = null;
let currentSessionId = null; // Track the current session

function getSessions(workspaceState) {
	return workspaceState.get(VSWIZARD_SESSIONS, []);
}

function saveSessions(workspaceState, sessions) {
	workspaceState.update(VSWIZARD_SESSIONS, sessions);
}

function getCurrentSession(workspaceState) {
	const sessions = getSessions(workspaceState);
	return sessions.find(s => s.id === currentSessionId);
}

function setCurrentSession(workspaceState, sessionId) {
	currentSessionId = sessionId;
	workspaceState.update(VSWIZARD_CURRENT_SESSION_ID, sessionId);
}

function loadCurrentSessionId(workspaceState) {
	currentSessionId = workspaceState.get(VSWIZARD_CURRENT_SESSION_ID, null);
}

async function generateSessionName(ollamaUrl, history, model) {
	// Use LLM to generate a session name from history, max 30 chars
	const prompt =
		"Summarize this chat in a short title (max 30 chars):\n" +
		history.map(m => `${m.sender === 'user' ? 'User' : 'Bot'}: ${m.text}`).join('\n');
	const requestBody = {
		model: model,
		prompt: prompt,
		stream: false
	};
	const response = await fetch(`${ollamaUrl}/api/generate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(requestBody)
	});
	if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
	const data = await response.json();
	let name = '';
	if (typeof data === 'object' && data !== null) {
		if ('response' in data) {
			name = String(data.response).trim();
		} else if ('text' in data) {
			name = String(data.text).trim();
		}
	}
	if (name.length > 30) name = name.slice(0, 30);
	return name || 'Untitled Session';
}

function activate(context) {
	console.log('VSWizard extension activating...');
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "vswizard" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('vswizard.helloWorld', function () {
		// The code you place here will be executed every time your command is executed

		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from VSWizard!');
	});

	context.subscriptions.push(disposable);

	const startChatDisposable = vscode.commands.registerCommand('vswizard.startChat', function () {
		vscode.commands.executeCommand('workbench.view.extension.vswizard-sidebar');
	});
	context.subscriptions.push(startChatDisposable);

	const setOllamaUrlCommand = vscode.commands.registerCommand('vswizard.setOllamaURL', async function () {
		const config = vscode.workspace.getConfiguration();
		const currentUrl = config.get('vswizard.ollamaUrl') || 'http://localhost:11434';
		const newUrl = await vscode.window.showInputBox({
			prompt: 'Set Ollama URL',
			value: currentUrl,
			ignoreFocusOut: true
		});
		if (newUrl && newUrl !== currentUrl) {
			await config.update('vswizard.ollamaUrl', newUrl, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Ollama URL set to: ${newUrl}`);
		} else {
			vscode.window.showInformationMessage(`Ollama URL remains: ${currentUrl}`);
		}
	});
	context.subscriptions.push(setOllamaUrlCommand);

	// Register the chat view provider
	chatViewProviderInstance = new ChatViewProvider(context.extensionUri, context.workspaceState);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('vswizard-chat', chatViewProviderInstance)
	);

	const listModelsCommand = vscode.commands.registerCommand('vswizard.listModels', async function () {
		const ollamaUrl = vscode.workspace.getConfiguration().get('vswizard.ollamaUrl') || 'http://localhost:11434';
		try {
			const models = await listOllamaModels(ollamaUrl);
			if (models && models.length > 0) {
				const modelDisplayNames = models.map(model => `${model.name} (context window: ${model.context_length})`);
				vscode.window.showQuickPick(modelDisplayNames, {
					placeHolder: 'Select an Ollama model'
				}).then(selectedDisplayName => {
					if (selectedDisplayName) {
						// Extract model name from display string
						const selectedModelName = selectedDisplayName.split(' ')[0];
						const selectedModel = models.find(model => model.name === selectedModelName);
						if (selectedModel) {
							context.workspaceState.update(OLLAMA_SELECTED_MODEL, selectedModel);
							vscode.window.showInformationMessage(`Selected model: ${selectedModel.name}`);
							// Inform the webview about the selected model's multimodal capability and name
							if (chatViewProviderInstance && chatViewProviderInstance._webviewView) {
								chatViewProviderInstance._webviewView.webview.postMessage({ command: 'setMultimodal', multimodal: selectedModel.multimodal });
								chatViewProviderInstance._webviewView.webview.postMessage({ command: 'setModelName', modelName: selectedModel.name });
							}
						}
					}
				});
			} else {
				vscode.window.showInformationMessage('No Ollama models found.');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Error listing Ollama models: ${error.message}`);
		}
	});

	context.subscriptions.push(listModelsCommand);

	// Command to clear the selected LLM (for testing "no LLM selected" state)
	const clearLLMSelectionCommand = vscode.commands.registerCommand('vswizard.clearLLMSelection', async function () {
		context.workspaceState.update(OLLAMA_SELECTED_MODEL, undefined);
		// Find all visible webviews and send the clear message
		const chatViews = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.input && typeof tab.input === 'object' && 'viewType' in tab.input && tab.input.viewType === 'vswizard-chat');
		// Fallback: send to all webview views if possible
		// This assumes only one chatViewProvider instance
		if (typeof chatViewProviderInstance !== 'undefined' && chatViewProviderInstance._webviewView) {
			// @ts-ignore
			chatViewProviderInstance._webviewView.webview.postMessage({ command: 'setModelName', modelName: '' });
		} else {
			// If we can't access the webview directly, show info to reload the chat panel
			vscode.window.showInformationMessage('LLM selection cleared. Please reload the chat panel to see the effect.');
		}
		// After clearing, show the model list popup
		await vscode.commands.executeCommand('vswizard.listModels');
	});
	context.subscriptions.push(clearLLMSelectionCommand);

	loadCurrentSessionId(context.workspaceState);

	// New Session command
	const newSessionCommand = vscode.commands.registerCommand('vswizard.newSession', async function () {
		const ollamaUrl = vscode.workspace.getConfiguration().get('vswizard.ollamaUrl') || 'http://localhost:11434';
		const selectedModel = context.workspaceState.get(OLLAMA_SELECTED_MODEL);
		const model = selectedModel ? selectedModel.name : 'llama2';
		const sessions = getSessions(context.workspaceState);
		const newId = 'session-' + Date.now();
		const newSession = { id: newId, name: 'New Session', history: [] };
		sessions.push(newSession);
		saveSessions(context.workspaceState, sessions);
		setCurrentSession(context.workspaceState, newId);
		context.workspaceState.update(OLLAMA_CHAT_HISTORY, []);
		if (chatViewProviderInstance) {
			chatViewProviderInstance._chatHistory = [];
		}
		if (chatViewProviderInstance && chatViewProviderInstance._webviewView) {
			chatViewProviderInstance._webviewView.webview.postMessage({ command: 'clearHistory' });
			chatViewProviderInstance._webviewView.webview.postMessage({ command: 'loadHistory', history: [] });
			chatViewProviderInstance._webviewView.webview.postMessage({ command: 'resetInput' });
		}
		vscode.window.showInformationMessage('Started a new chat session.');
	});
	context.subscriptions.push(newSessionCommand);

	// List History command
	const listHistoryCommand = vscode.commands.registerCommand('vswizard.listHistory', async function () {
		try {
			const sessions = getSessions(context.workspaceState);
			if (!sessions.length) {
				vscode.window.showInformationMessage('No chat sessions found.');
				return;
			}
			const picks = sessions.slice().reverse().map(s => ({ label: s.name, id: s.id }));
			const selected = await vscode.window.showQuickPick(picks.map(p => p.label), { placeHolder: 'Select a chat session to load' });
			if (selected) {
				const session = sessions.find(s => s.name === selected);
				if (session) {
					setCurrentSession(context.workspaceState, session.id);
					context.workspaceState.update(OLLAMA_CHAT_HISTORY, session.history);
					if (chatViewProviderInstance) {
						chatViewProviderInstance._chatHistory = session.history;
					}
					if (chatViewProviderInstance?._webviewView) {
						chatViewProviderInstance._webviewView.webview.postMessage({ command: 'loadHistory', history: session.history });
						chatViewProviderInstance._webviewView.webview.postMessage({ command: 'resetInput' });
					}
					// Also update the local chatHistory variable in the webview provider to avoid stale history
					chatViewProviderInstance._chatHistory = session.history;
				}
				vscode.window.showInformationMessage(`Loaded session: ${session.name}`);
			}
		} catch (error) {
			console.error('Error loading chat history:', error);
			vscode.window.showErrorMessage('Failed to load chat history.');
		}
	});
	context.subscriptions.push(listHistoryCommand);

	// Command: Select Provider (Ollama or OpenAI)
	const selectProviderCommand = vscode.commands.registerCommand('vswizard.selectProvider', async function () {
		const provider = await vscode.window.showQuickPick([
			{ label: 'Ollama', value: 'ollama' },
			{ label: 'OpenAI', value: 'openai' }
		], { placeHolder: 'Select LLM Provider' });
		if (provider) {
			context.workspaceState.update(VSWIZARD_PROVIDER, provider.value);
			vscode.window.showInformationMessage(`VSWizard provider set to: ${provider.label}`);
			// Optionally notify webview
			if (chatViewProviderInstance && chatViewProviderInstance._webviewView) {
				chatViewProviderInstance._webviewView.webview.postMessage({ command: 'setProvider', provider: provider.value });
			}
		}
	});
	context.subscriptions.push(selectProviderCommand);

	// Command: Set OpenAI Parameters
	const setOpenAIParamsCommand = vscode.commands.registerCommand('vswizard.setOpenAIParams', async function () {
		const apiKey = await vscode.window.showInputBox({
			prompt: 'Enter your OpenAI API Key',
			value: context.workspaceState.get(OPENAI_API_KEY) || '',
			ignoreFocusOut: true,
			password: true
		});
		if (apiKey) {
			context.workspaceState.update(OPENAI_API_KEY, apiKey);
		}
		const endpoint = await vscode.window.showInputBox({
			prompt: 'Enter OpenAI API Endpoint (default: https://api.openai.com/v1/chat/completions)',
			value: context.workspaceState.get(OPENAI_API_ENDPOINT) || 'https://api.openai.com/v1/chat/completions',
			ignoreFocusOut: true
		});
		if (endpoint) {
			context.workspaceState.update(OPENAI_API_ENDPOINT, endpoint);
		}
		const model = await vscode.window.showInputBox({
			prompt: 'Enter OpenAI Model (e.g., gpt-3.5-turbo, gpt-4o, etc)',
			value: context.workspaceState.get(OPENAI_SELECTED_MODEL) || DEFAULT_OPENAI_MODEL,
			ignoreFocusOut: true
		});
		if (model) {
			context.workspaceState.update(OPENAI_SELECTED_MODEL, model);
		}
		const temperature = await vscode.window.showInputBox({
			prompt: 'Set temperature (0.0 - 2.0)',
			value: String(context.workspaceState.get(OPENAI_TEMPERATURE) || '1.0'),
			ignoreFocusOut: true
		});
		if (temperature && !isNaN(Number(temperature))) {
			context.workspaceState.update(OPENAI_TEMPERATURE, Number(temperature));
		}
		vscode.window.showInformationMessage('OpenAI parameters updated.');
	});
	context.subscriptions.push(setOpenAIParamsCommand);
}

// Simple token count: split by whitespace and punctuation
// For more accuracy, use a tokenizer matching your LLM
function countTokens(text) {
	// Simple heuristic: whitespace/punctuation split, then multiply by 3 for a rougher LLM token estimate
	return text.split(/\s+|[.,!?;:()\[\]{}"'`]/).filter(Boolean).length * 3;
}

// WebviewViewProvider for the chat view
class ChatViewProvider {
	/**
	 * @param {vscode.Uri} extensionUri
	 * @param {vscode.Memento} workspaceState
	 */
	constructor(extensionUri, workspaceState) {
		this._extensionUri = extensionUri;
		this._workspaceState = workspaceState;
	}

	/**
	 * @param {vscode.WebviewView} webviewView
	 * @param {vscode.WebviewViewResolveContext} context
	 * @param {vscode.CancellationToken} _token
	 */
	resolveWebviewView(webviewView, context, _token) {
		this._abortController = null; // Track the current AbortController per webview
		this._webviewView = webviewView; // Store the webviewView instance for later use
		console.log('resolveWebviewView called for vswizard-chat');
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
		};

		// Get the HTML content for the webview
		const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.html');
		let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

		// Fix logo path for webview
		const logoUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vswizard.png'));
		htmlContent = htmlContent.replace('./vswizard.png', logoUri.toString());

		webviewView.webview.html = htmlContent;

		// Load chat history for current session
		loadCurrentSessionId(this._workspaceState);
		let chatHistory = [];
		const sessions = getSessions(this._workspaceState);
		if (currentSessionId) {
			const session = sessions.find(s => s.id === currentSessionId);
			if (session) chatHistory = session.history;
		}
		this._workspaceState.update(OLLAMA_CHAT_HISTORY, chatHistory);
		this._chatHistory = chatHistory;

		// Get the selected model and inform the webview
		const selectedModel = this._workspaceState.get(OLLAMA_SELECTED_MODEL);
		if (selectedModel) {
			webviewView.webview.postMessage({ command: 'setMultimodal', multimodal: selectedModel.multimodal });
			webviewView.webview.postMessage({ command: 'setModelName', modelName: selectedModel.name });
		} else {
			vscode.window.showInformationMessage('No Ollama model selected. Please run "List Ollama Models" first.');
			webviewView.webview.postMessage({ command: 'setMultimodal', multimodal: false });
			webviewView.webview.postMessage({ command: 'setModelName', modelName: '<Select LLM please>' }); // Default placeholder
		}

		// Get provider and OpenAI model for placeholder
		const provider = this._workspaceState.get(VSWIZARD_PROVIDER) || 'ollama';
		let openaiModel = this._workspaceState.get(OPENAI_SELECTED_MODEL) || DEFAULT_OPENAI_MODEL;
		if (provider === 'openai') {
			webviewView.webview.postMessage({ command: 'setModelName', modelName: `OpenAI (${openaiModel})` });
		}

		// Send history to webview
		webviewView.webview.onDidReceiveMessage(message => {
			if (message.command === 'getHistory') {
				webviewView.webview.postMessage({ command: 'loadHistory', history: chatHistory });
			}
		});

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(
			async message => {
				switch (message.command) {
					case 'sendMessage': {
						const provider = this._workspaceState.get(VSWIZARD_PROVIDER) || 'ollama';
						let openaiModel = this._workspaceState.get(OPENAI_SELECTED_MODEL) || DEFAULT_OPENAI_MODEL;
						if (provider === 'openai') {
							// OpenAI logic (refactored)
							const userMessage = { text: message.text, sender: 'user' };
							var cur_chatHistory = this._workspaceState.get(OLLAMA_CHAT_HISTORY, []);
							cur_chatHistory.push(userMessage);
							this._workspaceState.update(OLLAMA_CHAT_HISTORY, cur_chatHistory);
							this._chatHistory = cur_chatHistory;
							// Save to session
							const sessions = getSessions(this._workspaceState);
							const idx = sessions.findIndex(s => s.id === currentSessionId);
							if (idx !== -1) {
								sessions[idx].history = cur_chatHistory;
								if (sessions[idx].name === 'New Session' && cur_chatHistory.length === 1) {
									sessions[idx].name = message.text.length > 30 ? message.text.slice(0, 30) : message.text;
								}
								saveSessions(this._workspaceState, sessions);
							}
							// Abort any previous stream before starting a new one
							if (this._abortController) {
								this._abortController.abort();
							}
							this._abortController = new AbortController();
							await handleOpenAIChat(this);
							// After OpenAI streaming completes or errors, update placeholder
							if (this._webviewView) {
								this._webviewView.webview.postMessage({ command: 'setModelName', modelName: `OpenAI (${openaiModel})` });
							}
							break;
						}
						// Existing Ollama logic...
						const ollamaUrl = vscode.workspace.getConfiguration().get('vswizard.ollamaUrl') || 'http://localhost:11434';
						const userMessage = { text: message.text, sender: 'user' };
						//Get chatHistory from workspace state
						var cur_chatHistory = this._workspaceState.get(OLLAMA_CHAT_HISTORY, []);
						cur_chatHistory.push(userMessage);
						this._workspaceState.update(OLLAMA_CHAT_HISTORY, cur_chatHistory);
						this._chatHistory = cur_chatHistory; // Update local chat history
						// Save to session
						const sessions = getSessions(this._workspaceState);
						const idx = sessions.findIndex(s => s.id === currentSessionId);
						if (idx !== -1) {
							sessions[idx].history = cur_chatHistory;
							// Set session name to user's question if still default
							if (sessions[idx].name === 'New Session' && cur_chatHistory.length === 1) {
								sessions[idx].name = message.text.length > 30 ? message.text.slice(0, 30) : message.text;
							}
							saveSessions(this._workspaceState, sessions);
						}
						// Abort any previous stream before starting a new one
						if (this._abortController) {
							this._abortController.abort();
						}
						this._abortController = new AbortController();

						try {
							await sendMessageToOllama(
								ollamaUrl,
								message.text,
								this._workspaceState,
								webviewView,
								cur_chatHistory,
								OLLAMA_CHAT_HISTORY,
								OLLAMA_PARTIAL_RESPONSE,
								null,
								this._abortController.signal
							);
							// After bot response, update session
							const sessions = getSessions(this._workspaceState);
							const idx = sessions.findIndex(s => s.id === currentSessionId);
							if (idx !== -1) {
								sessions[idx].history = cur_chatHistory;
								saveSessions(this._workspaceState, sessions);
							}
							// Always update placeholder after response
							const provider = this._workspaceState.get(VSWIZARD_PROVIDER) || 'ollama';
							if (this._webviewView) {
								if (provider === 'openai') {
									const openaiModel = this._workspaceState.get(OPENAI_SELECTED_MODEL) || DEFAULT_OPENAI_MODEL;
									this._webviewView.webview.postMessage({ command: 'setModelName', modelName: `OpenAI (${openaiModel})` });
								} else {
									const selectedModel = this._workspaceState.get(OLLAMA_SELECTED_MODEL);
									this._webviewView.webview.postMessage({ command: 'setModelName', modelName: selectedModel ? selectedModel.name : '<Select LLM please>' });
								}
							}
						} catch (error) {
							if (error.name === 'AbortError') {
								// Stream was aborted by user
								const partResponse = this._workspaceState.get(OLLAMA_PARTIAL_RESPONSE);
								if (partResponse) {
									const partMessage = { text: partResponse, sender: 'bot' };
									cur_chatHistory.push(partMessage);
									this._workspaceState.update(OLLAMA_CHAT_HISTORY, cur_chatHistory);
									// Save updated chat history into current session
									const sessions = getSessions(this._workspaceState);
									const idx = sessions.findIndex(s => s.id === currentSessionId);
									if (idx !== -1) {
										sessions[idx].history = cur_chatHistory;
										// Generate session name for partial response
										try {
											const selectedModel = this._workspaceState.get(OLLAMA_SELECTED_MODEL);
											const model = selectedModel ? selectedModel.name : 'llama2';
											const name = await generateSessionName(vscode.workspace.getConfiguration().get('vswizard.ollamaUrl') || 'http://localhost:11434', cur_chatHistory, model);
											sessions[idx].name = name;
										} catch (e) {
											// ignore name generation errors
										}
										saveSessions(this._workspaceState, sessions);
									}
								}
								webviewView.webview.postMessage({ command: 'streamDone', sender: 'bot' });
							}
						} finally {
							this._abortController = null;
						}
						// After Ollama streaming completes or errors, update placeholder
						if (this._webviewView) {
							const selectedModel = this._workspaceState.get(OLLAMA_SELECTED_MODEL);
							const modelName = selectedModel ? selectedModel.name : '<Select LLM please>';
							this._webviewView.webview.postMessage({ command: 'setModelName', modelName });
						}
						break;
					}
					case 'getFileContext': {
						// message.type: "current" | "opening"
						// message.userMessage: string
						let fileContextText = '';
						let displayFileContextText = ''; // New variable for display text
						try {
							if (message.type === "current") {
								const editor = vscode.window.activeTextEditor;
								if (editor) {
									const fileName = editor.document.fileName.split(/[\\/]/).pop();
									const content = editor.document.getText();
									fileContextText = `\n\n[Current file: ${fileName}]\n[File Content Start]\n\`\`\`\n${content}\n\`\`\`\n[File Content End]`;
									displayFileContextText = `\n\n[Current file: ${fileName}]`; // Only file name for display
								} else {
									fileContextText = "\n\n[No file is currently open in the main editor]";
									displayFileContextText = "\n\n[No file is currently open in the main editor]";
								}
							} else if (message.type === "opening") {
								const tabGroups = vscode.window.tabGroups.all;
								if (tabGroups.length > 0) {
									// Loop through all tabs in all tab groups
									const allTabs = tabGroups.flatMap(group => group.tabs);
									if (allTabs.length > 0) {
										fileContextText = '';
										displayFileContextText = '\n\n[Open files:';
										for (const tab of allTabs) {
											try {
												let fileName = '';
												let content = '';
												if (tab.input && typeof tab.input === 'object' && 'uri' in tab.input) {
													const input = tab.input;
													// Cast input.uri to vscode.Uri to avoid type errors
													const uri = /** @type {vscode.Uri} */ (input.uri);
													fileName = uri.fsPath.split(/[\\/]/).pop();
													const document = await vscode.workspace.openTextDocument(uri);
													content = document.getText();
												} else if (tab.label) {
													fileName = tab.label;
													content = '[Content not available]';
												} else {
													fileName = '[Unknown]';
													content = '[Content not available]';
												}
												fileContextText += `\n\n[File: ${fileName}]\n[File Content Start]\n\`\`\`\n${content}\n\`\`\`\n[File Content End]`;
												displayFileContextText += ` ${fileName};`;
											} catch (err) {
												fileContextText += `\n\n[Error retrieving content for a tab: ${err.message}]`;
											}
										}
										displayFileContextText += ']';
									} else {
										fileContextText = "\n\n[No tabs are currently open in VSCode]";
										displayFileContextText = "\n\n[No tabs are currently open in VSCode]";
									}
								} else {
									fileContextText = "\n\n[No tab groups found in VSCode]";
									displayFileContextText = "\n\n[No tab groups found in VSCode]";
								}
							}
						} catch (err) {
							fileContextText = `\n\n[Error retrieving file context: ${err.message}]`;
							displayFileContextText = `\n\n[Error retrieving file context: ${err.message}]`;
						}
						const fullComposedMessage = message.userMessage + fileContextText;
						const displayComposedMessage = message.userMessage + displayFileContextText;
						const tokenCount = countTokens(fullComposedMessage);

						// After displaying file context, call AI with the composed message
						webviewView.webview.postMessage({
							command: 'displayUserMessageWithFileContext',
							fullText: fullComposedMessage,
							displayText: displayComposedMessage,
							tokenCount: tokenCount // Send token count to webview
						});
						// Call AI after getting file context
						const providerForContext = this._workspaceState.get(VSWIZARD_PROVIDER) || 'ollama';
						const userMsgForContext = { text: fullComposedMessage, sender: 'user' };
						this._chatHistory.push(userMsgForContext);
						this._workspaceState.update(OLLAMA_CHAT_HISTORY, this._chatHistory);
						if (this._abortController) {
							this._abortController.abort();
						}
						this._abortController = new AbortController();
						if (providerForContext === 'openai') {
							await handleOpenAIChat(this);
						} else {
							// Use Ollama provider to generate response							
							sendMessageToOllama(
								vscode.workspace.getConfiguration().get('vswizard.ollamaUrl') || 'http://localhost:11434',
								fullComposedMessage,
								this._workspaceState,
								webviewView,
								this._chatHistory,
								OLLAMA_CHAT_HISTORY,
								OLLAMA_PARTIAL_RESPONSE,
								null,
								this._abortController.signal
							);
						}

						break;
					}
					case 'stop': {
						if (this._abortController) {
							this._abortController.abort();
							this._abortController = null;
						}
						break;
					}
					case 'listOllamaModels': {
						// Trigger the listModels command to show the model selection popup
						await vscode.commands.executeCommand('vswizard.listModels');
						break;
					}
					case 'getCurrentOllamaModel': {
						// Respond to webview's request for current Ollama model name
						const selectedModel = this._workspaceState.get(OLLAMA_SELECTED_MODEL);
						if (selectedModel && this._webviewView) {
							this._webviewView.webview.postMessage({ command: 'setModelName', modelName: selectedModel.name });
						} else if (this._webviewView) {
							this._webviewView.webview.postMessage({ command: 'setModelName', modelName: '<Select LLM please>' });
						}
						break;
					}
				}
			}
		);
	}
}

// Helper function to handle OpenAI chat streaming for both sendMessage and getFileContext
async function handleOpenAIChat(providerInstance) {
	const workspaceState = providerInstance._workspaceState;
	const webviewView = providerInstance._webviewView;
	const abortController = providerInstance._abortController;

	const apiKey = workspaceState.get(OPENAI_API_KEY);
	const endpoint = workspaceState.get(OPENAI_API_ENDPOINT) || 'https://api.openai.com/v1/chat/completions';
	const model = workspaceState.get(OPENAI_SELECTED_MODEL) || DEFAULT_OPENAI_MODEL;
	const temperature = workspaceState.get(OPENAI_TEMPERATURE) || 1.0;
	const chatHistory = workspaceState.get(OLLAMA_CHAT_HISTORY, []);

	// Prepare messages for OpenAI API
	let messages = chatHistory.map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.text }));
	//messages.push({ role: 'user', content: userMessage });
	
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({ model, messages, temperature, stream: true }),
			signal: abortController.signal
		});

		if (!response.ok) throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let fullResponse = '';

		while (true) {
			const { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: false });

			while (true) {
				const newlineIndex = buffer.indexOf('\n');
				if (newlineIndex === -1) break;
				let line = buffer.substring(0, newlineIndex).trim();
				buffer = buffer.substring(newlineIndex + 1);
				if (!line.startsWith('data:')) continue;
				line = line.replace(/^data: /, '');
				if (line === '[DONE]') {
					if (webviewView) webviewView.webview.postMessage({ command: 'streamDone', sender: 'bot' });
					break;
				}
				try {
					const data = JSON.parse(line);
					const delta = data.choices?.[0]?.delta?.content;
					if (delta) {
						fullResponse += delta;
						if (webviewView) webviewView.webview.postMessage({ command: 'addChunk', text: delta, sender: 'bot' });
					}
				} catch {
					// ignore parse errors
				}
			}
		}
		if (fullResponse) {
			const botMessage = { text: fullResponse, sender: 'bot' };
			chatHistory.push(botMessage);
			workspaceState.update(OLLAMA_CHAT_HISTORY, chatHistory);
		}

	} catch (error) {
		if (webviewView) {
			webviewView.webview.postMessage({ command: 'addMessage', text: `Error: ${error.message}`, sender: 'bot' });
			webviewView.webview.postMessage({ command: 'resetSendButton' });
		}
	}
}

async function sendMessageToOllama(
	ollamaUrl,
	prompt,
	workspaceState,
	webviewView,
	chatHistory,
	historyKey,
	partRespnonseKey,
	image = null,
	abortSignal = undefined
) {
	const selectedModel = workspaceState.get(OLLAMA_SELECTED_MODEL);
	const model = selectedModel ? selectedModel.name : "llama2";
	const contextLength = selectedModel && selectedModel.context_length ? selectedModel.context_length : 2048;
	// Build prompt from history, respecting context window size
	const fullPrompt = buildPromptFromHistory(chatHistory, prompt, contextLength);
	const requestBody = {
		model: model,
		prompt: fullPrompt,
		stream: true
	};

	if (image) {
		requestBody.images = [image];
	}

	const response = await fetch(`${ollamaUrl || 'http://localhost:11434'}/api/generate`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(requestBody),
		signal: abortSignal
	});

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let fullResponse = '';

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: false });

		// Process complete JSON objects in the buffer
		while (true) {
			const newlineIndex = buffer.indexOf('\n');
			if (newlineIndex === -1) break;

			const jsonLine = buffer.substring(0, newlineIndex);
			buffer = buffer.substring(newlineIndex + 1);

			try {
				const data = JSON.parse(jsonLine);
				if (data.response) {
					fullResponse += data.response;
					workspaceState.update(partRespnonseKey, fullResponse);// Pass part response when user breaks the response.
					webviewView.webview.postMessage({ command: 'addChunk', text: data.response, sender: 'bot' });
				}
				if (data.done) {
					webviewView.webview.postMessage({ command: 'streamDone', sender: 'bot' });
					const botMessage = { text: fullResponse, sender: 'bot' };
					chatHistory.push(botMessage);
					workspaceState.update(historyKey, chatHistory);
					workspaceState.update(partRespnonseKey, ""); // Clear partial response
					return fullResponse;
				}
			} catch (error) {
				console.error('Error parsing JSON stream:', error);
			}
		}
	}

	console.warn('Stream ended without a done signal.');
	const botMessage = { text: fullResponse, sender: 'bot' };
	chatHistory.push(botMessage);
	workspaceState.update(historyKey, chatHistory);
	return fullResponse;
}

async function listOllamaModels(ollamaUrl) {
	const response = await fetch(`${ollamaUrl}/api/tags`);

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	/** @type {{ models: Array<{ name: string, modified_at: string, size: number, digest: string, details: any }> }} */
	const data = /** @type {{ models: Array<{ name: string, modified_at: string, size: number, digest: string, details: any }> }} */ (await response.json());
	if (!data.models) {
		return [];
	}

	const modelsWithDetails = await Promise.all(data.models.map(async (model) => {
		try {
			// Call /api/show endpoint to get detailed model info including context length
			const detailsResponse = await fetch(`${ollamaUrl}/api/show`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: model.name }),
			});

			if (!detailsResponse.ok) {
				console.error(`Error fetching details for model ${model.name}: ${detailsResponse.status}`);
				return { ...model, multimodal: false, context_length: 2048 }; // Default context length on error
			}

			const details = await detailsResponse.json();
			// Check if the model is multimodal (supports images). This might vary based on Ollama version or model.
			const isMultimodal = JSON.stringify(details).includes('vision'); // Basic check

			// Extract context window size if available
			let contextLength = 2048; // Default fallback
			if (details && typeof details === 'object' && details['details']) {
				let para_name = details['details']['family'] + ".context_length";
				// Use optional chaining and type checks to avoid TS errors
				if (typeof details['model_info'] === 'object' && details['model_info'] !== null &&
					details['model_info'][para_name] !== null &&
					typeof details['model_info'][para_name] === 'number') {
					contextLength = details['model_info'][para_name];
				} else if ('context_length' in details && typeof details['context_length'] === 'number') {
					contextLength = details['context_length'];
				} else if ('contextLength' in details && typeof details['contextLength'] === 'number') {
					contextLength = details['contextLength'];
				} else if ('context_window' in details && typeof details['context_window'] === 'number') {
					contextLength = details['context_window'];
				}
			}

			return { ...model, multimodal: isMultimodal, context_length: contextLength };
		} catch (error) {
			console.error(`Error fetching details for model ${model.name}: ${error.message}`);
			return { ...model, multimodal: false, context_length: 2048 }; // Default context length on error
		}
	}));

	return modelsWithDetails;
}

// Helper to build prompt from chat history, respecting contextLength
function buildPromptFromHistory(chatHistory, userMessage, contextLength) {
	// Format: alternating 'User:' and 'Bot:'
	const formatted = [];
	for (const msg of chatHistory) {
		if (msg.sender === 'user') {
			formatted.push(`User: ${msg.text}`);
		} else if (msg.sender === 'bot') {
			formatted.push(`Bot: ${msg.text}`);
		}
	}
	// Add the new user message
	formatted.push(`User: ${userMessage} (Do not prefix your response with "Bot:")`);

	// Start from the end, add messages until contextLength is reached
	let prompt = '';
	for (let i = formatted.length - 1; i >= 0; i--) {
		const next = formatted[i] + '\n';
		if ((prompt.length + next.length) > contextLength) break;
		prompt = next + prompt;
	}
	return prompt.trim();
}


// This method is called when your extension is deactivated
function deactivate() { }

module.exports = {
	activate,
	deactivate
}
