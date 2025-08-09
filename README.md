# AI Chat VSCode Extension

This extension provides a chat interface within VSCode to interact with LLM:
* a local Ollama Language Model
* OpenAI API

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

## OpenAI Support

You can use either a local Ollama model or OpenAI's API as the backend for chat.

To enable OpenAI support, configure parameters in VSCode:

- **Configure via Command**  
  Run **wzd: Set OpenAI API Parameters** to customize:  
  - **API Key** (required)  
  - **Endpoint URL** (default: `https://api.openai.com/v1`)  
  - **Model** (e.g. `gpt-3.5-turbo`, `gpt-4`)  
  - **Temperature** (0.0–1.0 for response randomness)

  Obtain a key from https://platform.openai.com/account/api-keys and enter it when prompted.

### Commands

- **wzd: Select LLM Provider (Ollama or OpenAI):** Choose between using Ollama or OpenAI for chat.
- **wzd: Set OpenAI API Parameters:** Configure OpenAI API key, endpoint, model, and temperature.

### Usage Example

```bash
code .
```  
After launching, select **OpenAI** as the provider and start chatting.

### Tips & Troubleshooting

- To switch providers at any time, run **wzd: Select LLM Provider**.
- To update model or temperature, rerun **wzd: Set OpenAI API Parameters**.
- Proxy or streaming settings can be adjusted in VSCode settings if needed.
- Refer to OpenAI API docs for advanced options: https://platform.openai.com/docs/api-reference/.

## Known Issues

*   Basic error handling for Ollama communication. More robust error reporting can be added in the future.
*   Image preview in the chat is not implemented.

## Release Notes

### 0.0.3

Text area input and think tag support.

### 0.0.2

Files attchement support, better UI

### 0.0.1

Initial basic implementation with core chat, model listing, history, and basic image support.

---

**Enjoy chatting with your local Ollama models in VSCode!**
