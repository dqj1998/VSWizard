# VSWizard Extension Deployment Guide

This guide explains how to deploy the VSWizard VSCode extension.

## Installation from VSIX

You can install the extension directly from the generated `.vsix` file:

1.  Open Visual Studio Code.
2.  Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
3.  Click on the three dots (...) in the upper-right corner of the Extensions view.
4.  Select "Install from VSIX...".
5.  Navigate to the `vswizard` directory in your file system.
6.  Select the `vswizard-0.0.1.vsix` file.
7.  Click "Install".
8.  Reload VSCode when prompted.

The extension should now be installed and available for use.

## Debugging the Extension

You can debug the extension directly within VSCode:

1.  Open the `vswizard` project folder in VSCode.
2.  Go to the Run and Debug view (`Ctrl+Shift+D` or `Cmd+Shift+D`).
3.  Select the "Run Extension" launch configuration from the dropdown menu at the top.
4.  Click the green play button to start debugging.

This will open a new VSCode window with your extension loaded. You can set breakpoints in your extension's code (`extension.js`) and step through the execution.

Any `console.log` statements in your extension will appear in the "Debug Console" panel of the original VSCode window.

## Building vsxi file for local install
* Open your terminal and navigate to the `vswizard` directory.
* Run the command: `vsce package` 

## Publishing to the VSCode Marketplace

To publish the extension to the official VSCode Marketplace, you need to follow these steps:

1.  **Get a Personal Access Token (PAT):**
    *   Go to the Azure DevOps organization for the VSCode Marketplace: [https://dev.azure.com/vscode](https://dev.azure.com/vscode)
    *   Create a new Personal Access Token with "Marketplace (Publish)" scope.
    *   Copy the generated PAT.

2.  **Create a Publisher:**
    *   If you don't have a publisher yet, create one through the VSCode Marketplace publisher management page: [https://marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)

3.  **Login with `vsce`:**
    *   Open your terminal and navigate to the `vswizard` directory.
    *   Run the command: `vsce login <publisher id>` (Replace `<publisher id>` with your publisher ID).
    *   When prompted, paste your Personal Access Token.

4.  **Publish the Extension:**
    *   In the terminal, still in the `vswizard` directory, run the command: `vsce publish`
    *   This will package and publish the current version of your extension to the Marketplace.

For more detailed information on publishing, refer to the official VSCode documentation: [https://code.visualstudio.com/api/working-with-extensions/publishing-extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

---

**Note:** Before publishing, ensure you have updated the `README.md`, `CHANGELOG.md`, and `package.json` with accurate information about your extension.
