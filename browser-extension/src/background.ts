/**
 * Service worker — opens the side panel when the toolbar action is clicked,
 * and configures the side panel default behaviour.
 */
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !chrome.sidePanel) return;
  await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
});
