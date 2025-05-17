// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const fs = require('fs'); // Import the 'fs' module

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */
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

	// Register the chat view provider
	const chatViewProvider = new ChatViewProvider(context.extensionUri, context.workspaceState);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('vswizard-chat', chatViewProvider)
	);

	const listModelsCommand = vscode.commands.registerCommand('vswizard.listModels', async function () {
		const ollamaUrl = vscode.workspace.getConfiguration().get('vswizard.ollamaUrl') || 'http://localhost:11434';
		try {
			const models = await listOllamaModels(ollamaUrl);
			if (models && models.length > 0) {
				const modelNames = models.map(model => model.name);
				vscode.window.showQuickPick(modelNames, {
					placeHolder: 'Select an Ollama model'
				}).then(selectedModelName => {
					if (selectedModelName) {
						const selectedModel = models.find(model => model.name === selectedModelName);
						if (selectedModel) {
							context.workspaceState.update('ollamaSelectedModel', selectedModel);
							vscode.window.showInformationMessage(`Selected model: ${selectedModel.name}`);
							// Inform the webview about the selected model's multimodal capability and name
							// This requires the webview panel instance, which is not directly accessible here.
							// A better approach is to send this info when the chat panel is created.
							// However, we can send a message to all webviews if needed, or refactor to pass the panel.
							// For now, we'll rely on the message sent when the panel is created/focused.
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
		console.log('resolveWebviewView called for vswizard-chat');
		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
		};

		// Get the HTML content for the webview
		const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.html');
		const htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
		webviewView.webview.html = htmlContent;

		// Load chat history
		const historyKey = 'ollamaChatHistory';
		let chatHistory = this._workspaceState.get(historyKey, []);

		// Get the selected model and inform the webview
		const selectedModel = this._workspaceState.get('ollamaSelectedModel');
		if (selectedModel) {
			webviewView.webview.postMessage({ command: 'setMultimodal', multimodal: selectedModel.multimodal });
			webviewView.webview.postMessage({ command: 'setModelName', modelName: selectedModel.name });
		} else {
			vscode.window.showInformationMessage('No Ollama model selected. Please run "List Ollama Models" first.');
			webviewView.webview.postMessage({ command: 'setMultimodal', multimodal: false });
			webviewView.webview.postMessage({ command: 'setModelName', modelName: 'your LLM' }); // Default placeholder
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
					case 'sendMessage':
						const ollamaUrl = vscode.workspace.getConfiguration().get('vswizard.ollamaUrl') || 'http://localhost:11434';
						const userMessage = { text: message.text, sender: 'user' };
						chatHistory.push(userMessage);
						this._workspaceState.update(historyKey, chatHistory);

						try {
							const response = await sendMessageToOllama(ollamaUrl, message.text, this._workspaceState); // Pass workspaceState
							const botMessage = { text: response, sender: 'bot' };
							chatHistory.push(botMessage);
							this._workspaceState.update(historyKey, chatHistory);
							webviewView.webview.postMessage({ command: 'addMessage', text: response, sender: 'bot' });
						} catch (error) {
							console.error('Error details:', error); // Log the full error object
							const selectedModel = this._workspaceState.get('ollamaSelectedModel');
							console.error('Selected model:', selectedModel); // Log the selected model
							vscode.window.showErrorMessage(`Error communicating with Ollama: ${error.message}. Check VS Code output for details.`);
							const errorMessage = { text: `Error: ${error.message}`, sender: 'bot' };
							chatHistory.push(errorMessage);
							this._workspaceState.update(historyKey, chatHistory);
							webviewView.webview.postMessage({ command: 'addMessage', text: `Error: ${error.message}`, sender: 'bot' });
						}
						break;
				}
			}
		);
	}
}


async function sendMessageToOllama(ollamaUrl, prompt, workspaceState, image = null) { // Add workspaceState parameter
	const selectedModel = workspaceState.get('ollamaSelectedModel'); // Use the passed workspaceState
	const model = selectedModel ? selectedModel.name : "llama2"; // Use selected model or default
	const requestBody = {
		model: model,
		prompt: prompt,
		stream: false // For simplicity, not using streaming for now
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
	});

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	/** @type {{ response: string }} */
	const data = /** @type {{ response: string }} */ (await response.json());
	return data.response;
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
			const detailsResponse = await fetch(`${ollamaUrl}/api/show`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: model.name }),
			});

			if (!detailsResponse.ok) {
				console.error(`Error fetching details for model ${model.name}: ${detailsResponse.status}`);
				return { ...model, multimodal: false }; // Assume not multimodal on error
			}

			const details = await detailsResponse.json();
			// Check if the model is multimodal (supports images). This might vary based on Ollama version or model.
			// A common indicator is the presence of a 'vision_adapter' or similar in the details.
			// For simplicity, we'll assume a model is multimodal if its details contain a 'parameter' related to vision.
			const isMultimodal = JSON.stringify(details).includes('vision'); // Basic check

			return { ...model, multimodal: isMultimodal };
		} catch (error) {
			console.error(`Error fetching details for model ${model.name}: ${error.message}`);
			return { ...model, multimodal: false }; // Assume not multimodal on error
		}
	}));

	return modelsWithDetails;
}


// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
