const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const ACCESSIBILITY_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
$result = @{ text = ""; source = "none"; elementName = "" }
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -ne $focused) {
  $result.elementName = $focused.Current.Name
  try {
    $textPattern = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $textPattern) {
      $selection = $textPattern.GetSelection()
      if ($selection.Length -gt 0) {
        $selected = $selection[0].GetText(-1)
        if (-not [string]::IsNullOrWhiteSpace($selected)) {
          $result.text = $selected
          $result.source = "uia-textpattern"
        }
      }
    }
  } catch {}

  if ([string]::IsNullOrWhiteSpace($result.text)) {
    try {
      $valuePattern = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($null -ne $valuePattern) {
        $value = $valuePattern.Current.Value
        if (-not [string]::IsNullOrWhiteSpace($value)) {
          $result.text = $value
          $result.source = "uia-valuepattern"
        }
      }
    } catch {}
  }
}
$result | ConvertTo-Json -Compress
`;

async function captureSelectedTextViaAccessibility() {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ACCESSIBILITY_SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const parsed = JSON.parse((stdout || "{}").trim() || "{}");
    const text = String(parsed.text || "");
    if (!text) {
      return null;
    }

    return {
      text,
      source: parsed.source || "uia",
      elementName: parsed.elementName || ""
    };
  } catch {
    return null;
  }
}

const CLIPBOARD_PROBE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$result = @{ text = ""; source = "clipboard-probe" }
$before = ""
if ([System.Windows.Forms.Clipboard]::ContainsText()) {
  $before = [System.Windows.Forms.Clipboard]::GetText()
}
[System.Windows.Forms.SendKeys]::SendWait("^c")
Start-Sleep -Milliseconds 180
if ([System.Windows.Forms.Clipboard]::ContainsText()) {
  $candidate = [System.Windows.Forms.Clipboard]::GetText()
  if (-not [string]::IsNullOrWhiteSpace($candidate) -and $candidate -ne $before) {
    $result.text = $candidate
  }
}
if ([string]::IsNullOrWhiteSpace($result.text)) {
  [System.Windows.Forms.SendKeys]::SendWait("^c")
  Start-Sleep -Milliseconds 140
  if ([System.Windows.Forms.Clipboard]::ContainsText()) {
    $candidate2 = [System.Windows.Forms.Clipboard]::GetText()
    if (-not [string]::IsNullOrWhiteSpace($candidate2) -and $candidate2 -ne $before) {
      $result.text = $candidate2
    }
  }
}
if (-not [string]::IsNullOrWhiteSpace($before)) {
  [System.Windows.Forms.Clipboard]::SetText($before)
}
$result | ConvertTo-Json -Compress
`;

const MOUSE_STATE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MouseState {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@

$leftDown = ([MouseState]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
@{ leftDown = $leftDown } | ConvertTo-Json -Compress
`;

const CTRL_A_STATE_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KeyState {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
"@

$ctrlDown = ([KeyState]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0
$aDown = ([KeyState]::GetAsyncKeyState(0x41) -band 0x8000) -ne 0
@{ ctrlA = ($ctrlDown -and $aDown) } | ConvertTo-Json -Compress
`;

async function captureSelectedTextViaClipboardProbe() {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-Command", CLIPBOARD_PROBE_SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const parsed = JSON.parse((stdout || "{}").trim() || "{}");
    const text = String(parsed.text || "");
    if (!text) {
      return null;
    }

    return {
      text,
      source: parsed.source || "clipboard-probe",
      elementName: ""
    };
  } catch {
    return null;
  }
}

async function isLeftMouseButtonDown() {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", MOUSE_STATE_SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      }
    );

    const parsed = JSON.parse((stdout || "{}").trim() || "{}");
    return Boolean(parsed.leftDown);
  } catch {
    return false;
  }
}

async function isCtrlASelectionGestureActive() {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", CTRL_A_STATE_SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      }
    );

    const parsed = JSON.parse((stdout || "{}").trim() || "{}");
    return Boolean(parsed.ctrlA);
  } catch {
    return false;
  }
}

module.exports = {
  captureSelectedTextViaAccessibility,
  captureSelectedTextViaClipboardProbe,
  isLeftMouseButtonDown,
  isCtrlASelectionGestureActive
};