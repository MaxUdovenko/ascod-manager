# ascod-manager

## Commands

```bash
npm run desktop:build -- --target aarch64-apple-darwin --bundles app,dmg
```

```bash
npm run desktop:dev
```

## Run project on macOS

These steps are for a fresh macOS machine after cloning the project from GitHub.

### 1. Install macOS build tools

Install Xcode Command Line Tools:

```bash
xcode-select --install
```

If macOS says the tools are already installed, you can continue.

### 2. Install Homebrew

If Homebrew is not installed yet, install it from the official script:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

After installation, follow any terminal instructions Homebrew prints for adding `brew` to your shell.

### 3. Install Node.js and Rust

Install Node.js:

```bash
brew install node
```

Install Rust:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Restart the terminal, or run:

```bash
source "$HOME/.cargo/env"
```

Check that the tools are available:

```bash
node --version
npm --version
rustc --version
cargo --version
```

### 4. Clone the project

```bash
git clone https://github.com/MaxUdovenko/ascod-manager.git
cd ascod-manager
```

### 5. Install project dependencies

```bash
npm install
```

### 6. Run the desktop app in development mode

```bash
npm run desktop:dev
```

This starts the Vite frontend and opens the Tauri desktop app.

### 7. Build the macOS app

For the current Mac architecture:

```bash
npm run desktop:build
```

For Apple Silicon builds:

```bash
npm run desktop:build -- --target aarch64-apple-darwin --bundles app,dmg
```
