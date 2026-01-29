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

# Set up SSH config for both root and claude user
RUN mkdir -p /root/.ssh /home/claude/.ssh && \
    printf '%s\n' 'Host github.com' \
    '    StrictHostKeyChecking no' \
    '    UserKnownHostsFile /dev/null' > /root/.ssh/config && \
    chmod 600 /root/.ssh/config && \
    cp /root/.ssh/config /home/claude/.ssh/config && \
    chown -R claude:claude /home/claude/.ssh && \
    chmod 700 /home/claude/.ssh && \
    chmod 600 /home/claude/.ssh/config

# Set git to use credential helper for root user
RUN /usr/bin/git.real config --global credential.helper 'cache --timeout=3600'

# Set git to use credential helper for claude user
USER claude
RUN /usr/bin/git.real config --global credential.helper 'cache --timeout=3600'
USER root

# Create entrypoint script
RUN printf '%s\n' '#!/bin/bash' \
    'set -e' \
    '' \
    '# Copy SSH keys if mounted' \
    'if [ -d "/tmp/.ssh" ]; then' \
    '    cp -r /tmp/.ssh/* /root/.ssh/ 2>/dev/null || true' \
    '    chmod 600 /root/.ssh/* 2>/dev/null || true' \
    'fi' \
    '' \
    '# Copy git config if mounted' \
    'if [ -f "/tmp/.gitconfig" ]; then' \
    '    cp /tmp/.gitconfig /root/.gitconfig' \
    'fi' \
    '' \
    '# Execute the command' \
    'exec "$@"' > /entrypoint.sh && \
    chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
