# Ollama Chat VSCode Extension

This extension provides a chat interface within VSCode to interact with a local Ollama Language Model.

## Features

*   **AI Chat:** Chat with a local Ollama LLM directly within VSCode.
*   **Configurable Ollama URL:** Set the URL of your local Ollama instance in the extension settings.
*   **List Available Models:** Command to list the LLMs available on your configured Ollama instance.
*   **Chat History:** Conversation history is saved per workspace.
*   **Image Support:** (Basic) If the selected model supports multimodal input, you can upload images to include in your prompts.

## Requirements

*   Visual Studio Code
*   A running instance of Ollama with at least one model downloaded. You can download Ollama from [https://ollama.ai/](https://ollama.ai/).

## Extension Settings

This extension contributes the following settings:

*   `vswizard.ollamaUrl`: The URL of the local Ollama instance (default: `http://localhost:11434`).

## Usage

1.  Install the extension from the VSCode Marketplace (once published).
2.  Open your VSCode settings and configure the "VSWizard: Ollama Url" setting if your Ollama instance is not running on the default address.
3.  Open the VSCode Command Palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows/Linux).
4.  Run the command "List Ollama Models" to see the available models and select one.
5.  Run the command "Start Ollama Chat" to open the chat panel.
6.  Type your messages and press Enter or click Send to chat with the selected Ollama model.
7.  If the selected model supports images, you can use the "Upload Image" button to include an image with your next message.

## Known Issues

*   Basic error handling for Ollama communication. More robust error reporting can be added in the future.
*   Streaming responses from Ollama are not yet supported, responses appear all at once.
*   Image preview in the chat is not implemented.

## Release Notes

### 0.0.1

Initial basic implementation with core chat, model listing, history, and basic image support.

---

**Enjoy chatting with your local Ollama models in VSCode!**
