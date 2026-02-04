FROM docker.io/library/almalinux:10

# Disable automatic updates for Claude Code
# ENV DISABLE_AUTOUPDATER=1

# Install system dependencies
RUN dnf install -y epel-release && dnf install -y \
    curl \
    git \
    openssh-clients \
    python3 \
    python3-pip \
    gcc \
    gcc-c++ \
    make \
    sudo \
    vim \
    jq \
    ca-certificates \
    gnupg2 \
    inotify-tools \
    rsync \
    socat \
    && dnf clean all

# Install Node.js 24.x
RUN curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - \
    && dnf install -y nodejs

# Install GitHub CLI
RUN dnf install -y 'dnf-command(config-manager)' \
    && dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo \
    && dnf install -y gh

# Install Claude Code using native installer
# Note: Alpine Linux requires libgcc, libstdc++, and ripgrep
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install OpenCode globally via npm
RUN npm install -g opencode

# Ensure claude is in PATH for all users
ENV PATH="/root/.local/bin:${PATH}"

# Create a non-root user with sudo privileges
RUN useradd -m -s /bin/bash claude && \
    echo 'claude ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers && \
    usermod -aG wheel claude

# Switch to claude user to install Claude Code
USER claude

# Install Claude Code for claude user
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install OpenCode for claude user (npm global is shared)
# OpenCode is already installed globally, but ensure user-level config works

# Ensure claude is in PATH for claude user
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/claude/.bashrc

# Switch back to root for remaining setup
USER root

# Create workspace directory and set ownership
RUN mkdir -p /workspace && \
    chown -R claude:claude /workspace

WORKDIR /workspace

# Create a wrapper script for git that prevents branch switching
RUN printf '%s\n' '#!/bin/bash' \
    '# Allow the initial branch creation' \
    'if [ ! -f /tmp/.branch-created ]; then' \
    '    /usr/bin/git.real "$@"' \
    '    if [[ "$1" == "checkout" ]] && [[ "$2" == "-b" ]]; then' \
    '        touch /tmp/.branch-created' \
    '    fi' \
    'else' \
    '    # After initial branch creation, prevent switching' \
    '    if [[ "$1" == "checkout" ]] && [[ "$2" != "-b" ]] && [[ "$*" != *"--"* ]]; then' \
    '        echo "Error: Branch switching is disabled in claude-code-runner"' \
    '        echo "You can only create new branches with git checkout -b"' \
    '        exit 1' \
    '    fi' \
    '    if [[ "$1" == "switch" ]]; then' \
    '        echo "Error: Branch switching is disabled in claude-code-runner"' \
    '        exit 1' \
    '    fi' \
    '    /usr/bin/git.real "$@"' \
    'fi' > /usr/local/bin/git-wrapper && \
    chmod +x /usr/local/bin/git-wrapper && \
    mv /usr/bin/git /usr/bin/git.real && \
    ln -s /usr/local/bin/git-wrapper /usr/bin/git

# Set up SSH config for both root and claude user (support any git host)
RUN mkdir -p /root/.ssh /home/claude/.ssh /home/claude/.gnupg && \
    printf '%s\n' 'Host *' \
    '    StrictHostKeyChecking no' \
    '    UserKnownHostsFile /dev/null' \
    '    AddKeysToAgent yes' > /root/.ssh/config && \
    chmod 600 /root/.ssh/config && \
    cp /root/.ssh/config /home/claude/.ssh/config && \
    chown -R claude:claude /home/claude/.ssh /home/claude/.gnupg && \
    chmod 700 /home/claude/.ssh /home/claude/.gnupg && \
    chmod 600 /home/claude/.ssh/config

# Set git to use credential helper for root user
RUN /usr/bin/git.real config --global credential.helper 'cache --timeout=3600'

# Set git to use credential helper for claude user
USER claude
RUN /usr/bin/git.real config --global credential.helper 'cache --timeout=3600'
USER root

# Create entrypoint script that properly sets up SSH and GPG for claude user
RUN printf '%s\n' '#!/bin/bash' \
    'set -e' \
    '' \
    '# Copy SSH keys from host if mounted' \
    'if [ -d "/tmp/.host-ssh" ]; then' \
    '    # Copy to claude user SSH directory' \
    '    cp -r /tmp/.host-ssh/* /home/claude/.ssh/ 2>/dev/null || true' \
    '    # Fix ownership and permissions' \
    '    chown -R claude:claude /home/claude/.ssh' \
    '    chmod 700 /home/claude/.ssh' \
    '    chmod 600 /home/claude/.ssh/* 2>/dev/null || true' \
    '    # Keep config readable' \
    '    [ -f /home/claude/.ssh/config ] && chmod 644 /home/claude/.ssh/config || true' \
    '    # Make public keys readable' \
    '    chmod 644 /home/claude/.ssh/*.pub 2>/dev/null || true' \
    '    # known_hosts should be writable' \
    '    [ -f /home/claude/.ssh/known_hosts ] && chmod 644 /home/claude/.ssh/known_hosts || true' \
    '    echo "✓ SSH keys configured"' \
    'fi' \
    '' \
    '# Copy GPG keys from host if mounted' \
    'if [ -d "/tmp/.host-gnupg" ]; then' \
    '    # Copy to claude user GPG directory' \
    '    cp -r /tmp/.host-gnupg/* /home/claude/.gnupg/ 2>/dev/null || true' \
    '    # Fix ownership and permissions' \
    '    chown -R claude:claude /home/claude/.gnupg' \
    '    chmod 700 /home/claude/.gnupg' \
    '    chmod 600 /home/claude/.gnupg/* 2>/dev/null || true' \
    '    # Some GPG files need specific permissions' \
    '    chmod 700 /home/claude/.gnupg/private-keys-v1.d 2>/dev/null || true' \
    '    echo "✓ GPG keys configured"' \
    'fi' \
    '' \
    '# Set up SSH agent forwarding if socket is mounted' \
    'if [ -S "/tmp/.ssh-agent-sock" ]; then' \
    '    # Create a socket proxy that claude user can access' \
    '    # Using socat to relay connections from claude'\''s socket to host'\''s socket' \
    '    CLAUDE_SOCK="/tmp/.ssh-agent-sock-claude"' \
    '    rm -f "$CLAUDE_SOCK"' \
    '    ' \
    '    # Start socat in background to relay socket connections' \
    '    socat UNIX-LISTEN:"$CLAUDE_SOCK",fork,user=claude,group=claude,mode=0600 UNIX-CONNECT:/tmp/.ssh-agent-sock &' \
    '    ' \
    '    # Wait a moment for socat to start' \
    '    sleep 0.5' \
    '    ' \
    '    # Test if the relay works' \
    '    export SSH_AUTH_SOCK="$CLAUDE_SOCK"' \
    '    if su - claude -c "SSH_AUTH_SOCK=$CLAUDE_SOCK ssh-add -l" >/dev/null 2>&1 || [ $? -eq 1 ]; then' \
    '        # Agent is accessible via relay (exit code 0 = has keys, 1 = no keys but working)' \
    '        echo "export SSH_AUTH_SOCK=$CLAUDE_SOCK" >> /home/claude/.bashrc' \
    '        echo "✓ SSH agent forwarding enabled via socat relay"' \
    '    else' \
    '        # Relay failed, kill socat and warn' \
    '        pkill -f "socat.*$CLAUDE_SOCK" 2>/dev/null || true' \
    '        rm -f "$CLAUDE_SOCK"' \
    '        echo "⚠ SSH agent socket mounted but relay failed - SSH keys will be used directly"' \
    '    fi' \
    'fi' \
    '' \
    '# Set up GPG agent forwarding if socket is mounted' \
    'if [ -S "/tmp/.gpg-agent-sock" ]; then' \
    '    # Create a socket proxy that claude user can access' \
    '    # Using socat to relay GPG agent connections' \
    '    CLAUDE_GPG_SOCK="/tmp/.gpg-agent-sock-claude"' \
    '    rm -f "$CLAUDE_GPG_SOCK"' \
    '    ' \
    '    # Start socat in background to relay socket connections' \
    '    socat UNIX-LISTEN:"$CLAUDE_GPG_SOCK",fork,user=claude,group=claude,mode=0600 UNIX-CONNECT:/tmp/.gpg-agent-sock &' \
    '    ' \
    '    # Update .gnupg directory if it exists' \
    '    mkdir -p /home/claude/.gnupg' \
    '    chown claude:claude /home/claude/.gnupg' \
    '    chmod 700 /home/claude/.gnupg' \
    '    ' \
    '    # Create symlink from GPG agent socket to the relay socket' \
    '    ln -sf "$CLAUDE_GPG_SOCK" /home/claude/.gnupg/S.gpg-agent 2>/dev/null || true' \
    '    ' \
    '    # Test if the relay works (gpg-connect-agent may not be available, so just test socket access)' \
    '    if [ -S "$CLAUDE_GPG_SOCK" ]; then' \
    '        echo "✓ GPG agent forwarding enabled via socat relay"' \
    '    else' \
    '        echo "⚠ GPG agent socket mounted but relay failed"' \
    '    fi' \
    'fi' \
    '' \
    '# Copy git config if mounted' \
    'if [ -f "/tmp/.gitconfig" ]; then' \
    '    cp /tmp/.gitconfig /home/claude/.gitconfig' \
    '    chown claude:claude /home/claude/.gitconfig' \
    '    echo "✓ Git config copied"' \
    'fi' \
    '' \
    '# Start GPG agent for claude user if GPG keys exist' \
    'if [ -d "/home/claude/.gnupg" ] && [ "$(ls -A /home/claude/.gnupg 2>/dev/null)" ]; then' \
    '    # Configure GPG to not use pinentry for passphrase (use loopback mode)' \
    '    mkdir -p /home/claude/.gnupg' \
    '    echo "allow-loopback-pinentry" >> /home/claude/.gnupg/gpg-agent.conf 2>/dev/null || true' \
    '    echo "pinentry-mode loopback" >> /home/claude/.gnupg/gpg.conf 2>/dev/null || true' \
    '    chown -R claude:claude /home/claude/.gnupg' \
    '    chmod 700 /home/claude/.gnupg' \
    '    chmod 600 /home/claude/.gnupg/*.conf 2>/dev/null || true' \
    'fi' \
    '' \
    '# Execute the command' \
    'exec "$@"' > /entrypoint.sh && \
    chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
