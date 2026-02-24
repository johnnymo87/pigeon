# Getting node/npm via devenv

This project needs node and npm. On this machine, they are not in the global
PATH because it uses Nix for package management. The solution is **devenv** --
a per-project development environment tool built on Nix.

devenv and direnv are already installed on this machine. You just need to
initialize and configure them in the project.

## Setup (one-time)

Run these commands from the project root:

```bash
devenv init
```

This creates two files:

- `devenv.nix` -- the environment definition
- `devenv.yaml` -- inputs (nixpkgs source)

Then edit `devenv.nix` to enable node. Replace its contents with:

```nix
{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    npm.enable = true;
  };
}
```

This gives you `node` and `npm` in the dev shell. devenv pins a recent stable
Node.js by default (currently 22.x LTS).

If you need a specific version:

```nix
{
  languages.javascript = {
    enable = true;
    npm.enable = true;
    package = pkgs.nodejs_20;  # or nodejs_18, nodejs_22
  };
}
```

## Entering the environment

Two options:

### Option A: Manual (explicit shell)

```bash
devenv shell
```

This drops you into a subshell with node/npm available. Run `node --version`
and `npm --version` to verify. Then run your commands as normal (`npm install`,
`npm run build`, etc.).

### Option B: Automatic via direnv (recommended)

Create a `.envrc` file in the project root:

```bash
echo 'use devenv' > .envrc
direnv allow
```

Now every time you (or a tool) `cd` into the project directory, the environment
activates automatically. No need to run `devenv shell` manually.

**This is the recommended approach** because it means every command you run
via the Bash tool will automatically have node/npm in PATH, without you needing
to remember to prefix anything.

## After setup

Once the environment is active:

```bash
node --version    # confirms node is available
npm install       # install project dependencies
npm run build     # or whatever the project needs
```

## Adding more tools

Edit `devenv.nix` to add anything else the project needs:

```nix
{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    npm.enable = true;
  };

  # Additional packages available in the shell
  packages = [
    pkgs.jq
    pkgs.curl
  ];
}
```

## What to commit

Commit these files so the environment is reproducible:

- `devenv.nix`
- `devenv.yaml`
- `devenv.lock` (generated on first use, pins exact versions)
- `.envrc`

Add `.devenv/` to `.gitignore` -- it is a local cache directory.

## Troubleshooting

If `devenv shell` fails with a build error, try:

```bash
devenv update   # refresh nixpkgs input
```

If direnv is not activating, check:

```bash
direnv status   # should show "Found .envrc"
direnv allow    # may need re-allow after editing .envrc
```
