import "./favmoa-service.js";
import { CLOUD_ENABLED, cloudPausedResponse } from "./feature-flags.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = typeof message?.type === "string" ? message.type : "";
  // Old, still-open documents can send messages after an extension update.
  // Retirement never resets, migrates, reads or otherwise changes their data.
  if (type.startsWith("NFS_")) {
    sendResponse({
      ok: false,
      code: "LEGACY_NOTION_RETIRED",
      error: "Notion 전용 화면은 종료되었습니다. 페이지를 새로고침한 뒤 Chrome의 FAVMOA 사이드 패널을 이용해 주세요. 이전 목록은 그대로 보관되어 있습니다."
    });
    return false;
  }
  // Keep responding to old cloud panels without loading any OAuth/network code.
  if (!CLOUD_ENABLED && type.startsWith("FAVMOA_CLOUD_")) {
    sendResponse(cloudPausedResponse());
  }
  // The catalog service owns modern requests and checks the extension sender.
  return false;
});

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    console.warn("FAVMOA side panel setup could not be completed.");
  });
}

// No persistent content-script channel is used by the browser-only release.
chrome.runtime.onConnect.addListener((port) => port.disconnect());
