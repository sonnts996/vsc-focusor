# Changelog

All notable changes to the "focusor" extension will be documented in this file.

## [0.1.1] - 2026-06-19

### Fixed
- Expanded all collapsed folders when using Expand All in the Changes view.
- Matched deleted file styling in Recents with the Changes view.
- Opened deleted files through Git content instead of missing working-tree paths.
- Opened new and untracked files directly from Changes instead of diffing against HEAD.

### Changed
- Removed the display mode setting and kept Changes and Recents together in the Focusor panel.

## [0.1.0] - 2026-05-07

### Added
- **Recents Panel**: A new view to track your recently opened files.
  - Automatically records opened files and maintains a history.
  - Support for pinning files to keep them easily accessible.
  - Dynamically displays git file statuses alongside recent files.
  - Integrated alongside Changes in the Focusor panel.
  - Option to group recent files by their parent repository.
- **Split Staged/Unstaged**: The Changes view now logically separates "Staged Changes" and "Changes" for clearer tracking.
- **Auto-Reveal**: The extension now automatically scrolls to and highlights the currently active editor file in both the Changes and Recents panels.
- **Hover Path Context**: Files now cleanly display their repository name and relative path in tooltips to reduce ambiguity.

### Changed
- Improved native UI consistency for Git File Status colors and tooltips.
- Removed folder icons in group headers for a cleaner look.

## [0.0.1] - 2026-05-05

- Initial release.
- Added sidebar panel for git changed repositories.
- Implemented file status badges and diff viewing.
- Added repository filtering (QuickPick).
- Added list and tree view modes.
- Added settings for UI customization.
