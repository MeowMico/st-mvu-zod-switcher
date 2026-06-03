# Agent Rules

This is a local-only SillyTavern extension/plugin project.

Rules:
- Only work inside this project folder by default.
- Do not read or modify SillyTavern files unless the user explicitly provides a specific path.
- Do not scan Desktop, Downloads, Documents, Private, ~/.config, ~/.ssh, browser data, or unrelated folders.
- Do not read API keys, .env files, secrets, or private chat logs.
- Do not modify real SillyTavern data directly.
- Prefer fake sample data and a clear installation guide.
- Ask before running commands or editing files.
