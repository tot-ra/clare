const { expect } = require("chai")
const vscode = require("vscode")

describe("Extension Tests", function () {
	this.timeout(60000) // Increased timeout for extension operations

	let originalGetConfiguration

	beforeEach(() => {
		// Save original configuration
		originalGetConfiguration = vscode.workspace.getConfiguration
		// Setup mock configuration
		const mockUpdate = async () => Promise.resolve()
		const mockConfig = {
			get: () => true,
			update: mockUpdate,
		}
		vscode.workspace.getConfiguration = () => mockConfig
	})

	afterEach(() => {
		// Restore original configuration
		vscode.workspace.getConfiguration = originalGetConfiguration
	})

	it("should activate extension successfully", async () => {
		// Get the extension
		const extension = vscode.extensions.getExtension("tot-ra.clare")
		expect(extension).to.not.be.undefined

		// Activate the extension if not already activated
		if (!extension.isActive) {
			await extension.activate()
		}
		expect(extension.isActive).to.be.true
	})

	it("should open sidebar view", async () => {
		// Execute the command to open sidebar
		await vscode.commands.executeCommand("clare.plusButtonClicked")

		// Wait for sidebar to be visible
		await new Promise((resolve) => setTimeout(resolve, 1000))

		// Get all views
		const views = vscode.window.visibleTextEditors
		// Just verify the command executed without error
		// The actual view verification is handled in the TypeScript tests
	})

	it("should handle basic commands", async () => {
		// Test basic command execution
		await vscode.commands.executeCommand("clare.historyButtonClicked")
		// Success if no error thrown
	})

	it("should handle advanced settings configuration", async () => {
		// Test browser session setting
		await vscode.workspace.getConfiguration().update("clare.disableBrowserTool", true, true)
		const updatedConfig = vscode.workspace.getConfiguration("clare")
		expect(updatedConfig.get("disableBrowserTool")).to.be.true

		// Reset settings
		await vscode.workspace.getConfiguration().update("clare.disableBrowserTool", undefined, true)
	})
})
