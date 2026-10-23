FROM docker.io/library/almalinux:10

# Disable automatic updates for Claude Code
# ENV DISABLE_AUTOUPDATER=1

# Layer 1: Install all system packages (dnf/yum) in a single layer
RUN dnf install -y epel-release \
    && dnf install -y 'dnf-command(config-manager)' \
    && dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo \
    && curl -fsSL https://rpm.nodesource.com/setup_24.x | bash - \
    && dnf install -y \
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
        nodejs \
        gh \
    && dnf clean all \
    && rm -rf /var/cache/dnf /var/cache/yum /tmp/*

# Layer 2: Install all code runner tools (npm/pip/curl) in a single layer
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && npm install -g \
        opencode-ai@latest \
        oh-my-opencode@latest \
        @openai/codex@latest \
        @qwen-code/qwen-code@latest \
    && pip3 install --no-cache-dir uv \
    && uv tool install --python 3.13 kimi-cli \
    && npm cache clean --force \
    && uv cache clean \
    && rm -rf /tmp/* /root/.cache/pip

# Ensure claude is in PATH for all users
ENV PATH="/root/.local/bin:${PATH}"

# Layer 3: Create user, workspace, git wrapper, SSH/git config — all filesystem setup
RUN useradd -m -s /bin/bash claude \
    && echo 'claude ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \
    && usermod -aG wheel claude \
    && mkdir -p /workspace \
    && chown -R claude:claude /workspace \
    # Git wrapper script:
    # - shadow mode: prevent branch switching after initial setup
    # - direct mode: allow only read-only Git inspection
    && printf '%s\n' '#!/bin/bash' \
        '' \
        '# Find the git subcommand, skipping global options that take a value.' \
        'args=("$@")' \
        'cmd=""' \
        'i=0' \
        'while [ $i -lt ${#args[@]} ]; do' \
        '    a="${args[$i]}"' \
        '    case "$a" in' \
        '        -C|--git-dir|--work-tree|--namespace|-c)' \
        '            i=$((i+2))' \
        '            ;;' \
        '        -*)' \
        '            i=$((i+1))' \
        '            ;;' \
        '        *)' \
        '            cmd="$a"' \
        '            break' \
        '            ;;' \
        '    esac' \
        'done' \
        '' \
        'if [ "$CLAUDE_RUNNER_DIRECT_MODE" = "1" ]; then' \
        '    if [ "$1" = "--version" ] || [ "$1" = "version" ]; then' \
        '        exec /usr/bin/git.real "$@"' \
        '    fi' \
        '' \
        '    allow=0' \
        '    case "$cmd" in' \
        '        status|diff|log|show|rev-parse|ls-files|ls-tree|ls-remote|blame|describe|grep|cat-file|whatchanged|shortlog|reflog|fsck|count-objects|check-ignore|check-attr|merge-base|rev-list|diff-tree|diff-files|show-ref|for-each-ref|name-rev|var)' \
        '            allow=1' \
        '            ;;' \
        '        config)' \
        '            for a in "$@"; do' \
        '                case "$a" in' \
        '                    --get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope)' \
        '                        allow=1' \
        '                        ;;' \
        '                esac' \
        '            done' \
        '            ;;' \
        '        remote)' \
        '            next="${args[$((i+1))]}"' \
        '            case "$next" in' \
        '                ""|-v|--verbose|get-url|show) allow=1 ;;' \
        '            esac' \
        '            ;;' \
        '        branch)' \
        '            next="${args[$((i+1))]}"' \
        '            case "$next" in' \
        '                ""|-a|-r|-v|-vv|--list|--show-current|--contains|--merged|--no-merged|--points-at|--format=*) allow=1 ;;' \
        '            esac' \
        '            ;;' \
        '        tag)' \
        '            next="${args[$((i+1))]}"' \
        '            case "$next" in' \
        '                ""|-l|--list|-n*|--contains|--points-at|--merged|--no-merged) allow=1 ;;' \
        '            esac' \
        '            ;;' \
        '        stash)' \
        '            next="${args[$((i+1))]}"' \
        '            case "$next" in' \
        '                list|show) allow=1 ;;' \
        '            esac' \
        '            ;;' \
        '        worktree)' \
        '            next="${args[$((i+1))]}"' \
        '            [ "$next" = "list" ] && allow=1' \
        '            ;;' \
        '        submodule)' \
        '            next="${args[$((i+1))]}"' \
        '            case "$next" in' \
        '                status|summary) allow=1 ;;' \
        '            esac' \
        '            ;;' \
        '    esac' \
        '' \
        '    if [ "$allow" != "1" ]; then' \
        '        echo "Error: Git command ${cmd:-<unknown>} is disabled in direct workspace mode." >&2' \
        '        echo "Direct mode only allows read-only Git inspection. Use shadow mode for Git workflows." >&2' \
        '        exit 1' \
        '    fi' \
        '' \
        '    exec /usr/bin/git.real "$@"' \
        'fi' \
        '' \
        '# Shadow mode: allow the initial branch creation, then prevent switching.' \
        'if [ ! -f /tmp/.branch-created ]; then' \
        '    /usr/bin/git.real "$@"' \
        '    if [[ "$1" == "checkout" ]] && [[ "$2" == "-b" || "$2" == "-B" ]]; then' \
        '        touch /tmp/.branch-created' \
        '    fi' \
        'else' \
        '    if [[ "$1" == "checkout" ]] && [[ "$2" != "-b" ]] && [[ "$2" != "-B" ]] && [[ "$*" != *"--"* ]]; then' \
        '        echo "Error: Branch switching is disabled in claude-code-runner" >&2' \
        '        echo "You can only create new branches with git checkout -b" >&2' \
        '        exit 1' \
        '    fi' \
        '    if [[ "$1" == "switch" ]]; then' \
        '        echo "Error: Branch switching is disabled in claude-code-runner" >&2' \
        '        exit 1' \
        '    fi' \
        '    /usr/bin/git.real "$@"' \
        'fi' > /usr/local/bin/git-wrapper \
    && chmod +x /usr/local/bin/git-wrapper \
    && mv /usr/bin/git /usr/bin/git.real \
    && ln -s /usr/local/bin/git-wrapper /usr/bin/git \
    # SSH config for both root and claude user
    && mkdir -p /root/.ssh /home/claude/.ssh /home/claude/.gnupg \
    && printf '%s\n' 'Host *' \
        '    StrictHostKeyChecking no' \
        '    UserKnownHostsFile /dev/null' \
        '    AddKeysToAgent yes' > /root/.ssh/config \
    && chmod 600 /root/.ssh/config \
    && cp /root/.ssh/config /home/claude/.ssh/config \
    && chown -R claude:claude /home/claude/.ssh /home/claude/.gnupg \
    && chmod 700 /home/claude/.ssh /home/claude/.gnupg \
    && chmod 600 /home/claude/.ssh/config \
    # Git credential helper for root
    && /usr/bin/git.real config --global credential.helper 'cache --timeout=3600'

WORKDIR /workspace

# Layer 4 (claude user): Install user-scoped tools + git config
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && uv tool install --python 3.13 kimi-cli \
    && echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/claude/.bashrc \
    && /usr/bin/git.real config --global credential.helper 'cache --timeout=3600' \
    && uv cache clean \
    && rm -rf /tmp/* ~/.cache/pip
USER root

# Create entrypoint script that properly sets up SSH and GPG for claude user
RUN printf '%s\n' '#!/bin/bash' \
    'set -e' \
    '' \
    '# Align the claude user with the host UID/GID for direct workspace mode.' \
    '# Never chown /workspace here: it may be the actual project directory of the user.' \
    'if [ -n "$HOST_UID" ] && [ -n "$HOST_GID" ]; then' \
    '    if [ "$(id -u claude)" != "$HOST_UID" ] || [ "$(id -g claude)" != "$HOST_GID" ]; then' \
    '        groupmod -o -g "$HOST_GID" claude 2>/dev/null || true' \
    '        usermod -o -u "$HOST_UID" claude 2>/dev/null || true' \
    '        chown -R claude:claude /home/claude 2>/dev/null || true' \
    '    fi' \
    'fi' \
    '' \
    '# Copy SSH keys from host if mounted' \
    'if [ -d "/tmp/.host-ssh" ]; then' \
    '    # Copy to claude user SSH directory' \
    '    cp -r /tmp/.host-ssh/* /home/claude/.ssh/ 2>/dev/null || true' \
    '    # Fix ownership and permissions' \
    '    chown -R claude:claude /home/claude/.ssh 2>/dev/null || true' \
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
    '    chown -R claude:claude /home/claude/.gnupg 2>/dev/null || true' \
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
    '    chown claude:claude /home/claude/.gnupg 2>/dev/null || true' \
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
    '    chown claude:claude /home/claude/.gitconfig 2>/dev/null || true' \
    '    echo "✓ Git config copied"' \
    'fi' \
    '' \
    '# Start GPG agent for claude user if GPG keys exist' \
    'if [ -d "/home/claude/.gnupg" ] && [ "$(ls -A /home/claude/.gnupg 2>/dev/null)" ]; then' \
    '    # Configure GPG to not use pinentry for passphrase (use loopback mode)' \
    '    mkdir -p /home/claude/.gnupg' \
    '    echo "allow-loopback-pinentry" >> /home/claude/.gnupg/gpg-agent.conf 2>/dev/null || true' \
    '    echo "pinentry-mode loopback" >> /home/claude/.gnupg/gpg.conf 2>/dev/null || true' \
    '    chown -R claude:claude /home/claude/.gnupg 2>/dev/null || true' \
    '    chmod 700 /home/claude/.gnupg' \
    '    chmod 600 /home/claude/.gnupg/*.conf 2>/dev/null || true' \
    'fi' \
    '' \
    '# Execute the command' \
    'exec "$@"' > /entrypoint.sh && \
    chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
