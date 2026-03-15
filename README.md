# Code Bubble Tutor

Windows desktop assistant for explaining code from any app on screen.

## Current MVP

- Global hotkey first tries Windows accessibility text capture from the focused app.
- If no accessible selected text is available, it opens a full-screen overlay.
- Drag to select a code region anywhere on screen.
- Region is captured, OCR'd, sent to OpenRouter, and explained.
- Explanation appears in a floating bubble near the cursor.
- App stays in the system tray and exposes a real settings window.

Hotkey interaction behavior:

- Press the hotkey once to arm selection mode.
- Keep using your mouse normally and highlight code in the active app.
- When selected text is detected (UIA or clipboard probe), a bubble appears near the cursor with explanation.
- Overlay capture remains available manually from tray/settings.

## Why This Is Not Bare Space

System-wide interception of plain `Space` is not public-app friendly because it interferes with normal typing across Windows. The default global hotkey is `Ctrl+Shift+Space`, which opens the overlay safely from any app.

## Config

On first launch the app creates a config file in the Electron user data folder. The settings window now lets you edit and save config values directly. The `Open Config` button is still available for advanced edits.

Config fields:

- `apiKey`
- `endpoint`
- `model`
- `openRouterTitle`
- `explanationLevel`
- `hotkey`
- `useAccessibilityFirst`

Recommended model:

- `deepseek/deepseek-chat`

## Run

```powershell
npm install
npm run dev
```

## Build

```powershell
npm run dist
```

This now targets both:

- NSIS installer
- portable executable build

If you have a real Windows code-signing certificate configured through standard `electron-builder` environment variables, use:

```powershell
npm run dist:signed
```

Without a trusted certificate, the build will still be unsigned. A truly public signed installer cannot be produced locally without that certificate.

If the NSIS installer step fails on Windows due local code-sign helper privileges, use the generated portable build instead:

- `release/win-unpacked/Code Bubble Tutor.exe`
- `release/Code Bubble Tutor-Setup-0.1.0-x64.exe`
- `release/Code Bubble Tutor-Portable-0.1.0-x64.exe`

Local config file used at runtime:

- `%APPDATA%/desktop-code-assistant/config.json`
