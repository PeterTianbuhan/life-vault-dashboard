# Life Vault Dashboard

Life Vault Dashboard is an Obsidian desktop plugin for shared vault workflows.
It started as a personal dashboard for a shared vault maintained by Peter and his partner, with the goal of turning GitHub sync, time-based lookup, and local note operations into safe visual actions.

The current version focuses on a beginner-friendly GitHub sync card, a plain checkbox todo board, and a time-based content search card.

## Features

- Chinese-first dashboard UI for shared vault GitHub sync.
- Beginner-friendly sync status with safe buttons for checking, pulling, saving, and pushing.
- Upload preview before committing changes.
- Plain todo board generated from Markdown checkbox tasks.
- Time-based content lookup using `created` frontmatter.
- Optional `created` frontmatter for new Markdown files.
- Conservative `updated` maintenance: before committing, only Markdown files that Git already reports as changed get their `updated` value refreshed.
- Long result lists use scrollable panels so the dashboard stays compact.

## Requirements

- Obsidian desktop.
- Git installed and available on PATH.
- Windows users should install [Git for Windows](https://git-scm.com/download/win), then restart Obsidian.

The plugin is desktop-only because the sync card runs local Git commands.

## Installation

### BRAT

Until this plugin is submitted to the Obsidian community plugin directory, install it with BRAT:

1. Install the Obsidian BRAT plugin.
2. Add this repository as a beta plugin.
3. Enable `Life Vault 同步面板` in Obsidian community plugins.

### Manual

Copy these files into:

```text
<vault>/.obsidian/plugins/life-vault-dashboard/
```

Required files:

```text
main.js
manifest.json
styles.css
```

Then reload Obsidian and enable the plugin.

## Release

Create a tag such as `0.1.0` and push it. The release workflow uploads:

- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`

## Notes

This plugin is desktop-only because it runs local Git commands and reads local vault metadata.
