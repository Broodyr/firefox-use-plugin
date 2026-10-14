// firefox-use: prefs for the claude-dev profile.
// Written by setup/setup.ps1. %SANDBOX% is replaced with the downloads sandbox path.
// Re-run setup.ps1 to rewrite this file; edits made here by hand are overwritten.

// Remote control and devtools (needed for BiDi system access and RDP)
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);

// Version stability: add-ons only update when the user updates them by hand
user_pref("extensions.update.enabled", false);
user_pref("extensions.update.autoUpdateDefault", false);
user_pref("app.update.disabledForTesting", true);

// Downloads go only to the sandbox folder
user_pref("browser.download.dir", "%SANDBOX%");
user_pref("browser.download.useDownloadDir", true);
user_pref("browser.download.folderList", 2);
user_pref("browser.download.always_ask_before_handling_new_types", false);

// No secrets in the dev profile
user_pref("signon.rememberSignons", false);
user_pref("signon.autofillForms", false);
user_pref("extensions.formautofill.addresses.enabled", false);
user_pref("extensions.formautofill.creditCards.enabled", false);
user_pref("identity.fxaccounts.enabled", false);

// Quiet startup and shutdown
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.startup.page", 0);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("toolkit.startup.max_resumed_crashes", -1);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.discovery.enabled", false);
user_pref("extensions.getAddons.showPane", false);
user_pref("extensions.htmlaboutaddons.recommendations.enabled", false);

// Agent window: tab groups on, keep rendering when the window is minimised or covered
user_pref("browser.tabs.groups.enabled", true);
user_pref("browser.tabs.groups.smart.enabled", false);
user_pref("widget.windows.window_occlusion_tracking.enabled", false);

// Extension development: keep internal UUIDs and storage stable across reinstalls
user_pref("extensions.webextensions.keepUuidOnUninstall", true);
user_pref("extensions.webextensions.keepStorageOnUninstall", true);

// Own taskbar button: claude-dev windows don't stack with the user's Firefox (per-profile AppUserModelID)
user_pref("taskbar.grouping.useprofile", true);
