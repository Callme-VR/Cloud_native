# Start from the official slim Python base
FROM python:3.12-slim


# Install git and essential tools, then purge apt caches to keep the image small
RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*

# Pre-configure git identity so git operations inside /workspace never prompt for user info
RUN git config --global user.email "agent@cloudnative.local" && \
  git config --global user.name "CloudNativeAgent" && \
  git config --global init.defaultBranch main && \
  git config --global --add safe.directory /workspace

# Set default working directory
WORKDIR /workspace