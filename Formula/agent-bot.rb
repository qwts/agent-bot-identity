# typed: false
# frozen_string_literal: true

# Agent-bot Homebrew formula.
# Self-tap: brew tap qwts/agent-bot-identity https://github.com/qwts/agent-bot-identity.git
# Then: brew install agent-bot
#
# The formula installs the runtime tree into libexec and symlinks the portable
# launcher. It does not write ~/.local/bin, Git core.hooksPath, or shell
# startup files — run `agent-bot bootstrap --machine-only` after install.
#
# To release a new version:
#   1. Bump package.json, merge to main, and push tag vX.Y.Z.
#   2. Update url and sha256 below to that tag's GitHub archive.
#   3. Merge the formula pin. Tap HEAD is the formula; the tag is the Cellar source.
class AgentBot < Formula
  desc "Per-harness GitHub App identities for coding agents"
  homepage "https://github.com/qwts/agent-bot-identity"
  url "https://github.com/qwts/agent-bot-identity/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "7c857ccb98a6d4268757d7d6ef3e8d0a9d05f160301d847dc8863c6235b0117d"
  license "MIT"
  head "https://github.com/qwts/agent-bot-identity.git", branch: "main"

  depends_on "node"

  def install
    %w[tests tools governance Formula].each { |path| rm_r(path) if File.exist?(path) }

    libexec.install Dir["*"]
    bin.install_symlink libexec/"agent-bot"
  end

  def caveats
    <<~EOS
      Homebrew installs the runtime tree only. Machine wiring (the managed
      ~/.local/bin/agent-bot symlink, Git hooks, and PATH registration) is
      still an operator step:

        agent-bot bootstrap --profile /path/to/organization-profile.json --with-gh-shim --machine-only

      If ~/.local/bin/agent-bot already points at a git checkout, move that
      symlink aside first:

        rm ~/.local/bin/agent-bot

      Newer Homebrew may require:

        brew trust qwts/agent-bot-identity
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agent-bot --version")
    assert_match "bootstrap", shell_output("#{bin}/agent-bot --help")
  end
end
