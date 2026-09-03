# typed: false
# frozen_string_literal: true

# Agent-bot Homebrew formula.
# Self-tap: brew tap qwts/agent-bot-identity https://github.com/qwts/agent-bot-identity.git
# Then: brew install agent-bot
#
# The formula installs the runtime tree into libexec and a prefix wrapper that
# points at the stable opt launcher and Homebrew's `node` opt_bin. It does not
# write ~/.local/bin, Git core.hooksPath, or shell startup files — run
# `agent-bot bootstrap --machine-only` after install. That bootstrap records
# the opt wrapper, not a versioned Cellar path, so `brew upgrade` keeps hooks.
#
# To release a new version:
#   1. Bump package.json, merge to main, and push tag vX.Y.Z.
#   2. Update url and sha256 below to that tag's GitHub archive.
#   3. Merge the formula pin. Tap HEAD is the formula; the tag is the Cellar source.
class AgentBot < Formula
  desc "Per-harness GitHub App identities for coding agents"
  homepage "https://github.com/qwts/agent-bot-identity"
  url "https://github.com/qwts/agent-bot-identity/archive/refs/tags/v0.4.0.tar.gz"
  sha256 "912d8260d53a1d8bc36c283c1dd71af447940d60ab5a7600a012221e97bccc76"
  license "MIT"
  head "https://github.com/qwts/agent-bot-identity.git", branch: "main"

  depends_on "node"

  def install
    %w[tests tools governance Formula].each { |path| rm_r(path) if File.exist?(path) }

    libexec.install Dir["*"]
    chmod 0755, libexec/"agent-bot"
    (bin/"agent-bot").write <<~SH
      #!/bin/sh
      export AGENT_BOT_SYSTEM_NODE_DIRS="#{Formula["node"].opt_bin}${AGENT_BOT_SYSTEM_NODE_DIRS:+ $AGENT_BOT_SYSTEM_NODE_DIRS}"
      exec "#{opt_libexec}/agent-bot" "$@"
    SH
    chmod 0755, bin/"agent-bot"
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
