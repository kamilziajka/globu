# globu

Command line program for Globu. It keeps OKF knowledge bases (`docs/` directories) inside a repo and gives Claude Code a per-user registry of knowledge shards: which knowledge exists on this machine, when to consult it and where it may write.

```sh
npm install -g globu
globu --help
globu base --help
```

The globu plugin for Claude Code installs this package for its hooks and skills. The program never prompts, and every command accepts `--json`.
