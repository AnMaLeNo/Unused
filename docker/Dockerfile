# Image de base des tâches : un « PC » pour Claude. Il y est root, libre
# d'installer ce qu'il veut ; ce qu'il installe est conservé par le commit
# du container après chaque itération réussie.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git zstd procps less \
 && rm -rf /var/lib/apt/lists/*

# Installeur officiel : binaire natif (linux-arm64 sur le Pi) dans /root/.local/bin.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

# Autorise --dangerously-skip-permissions en root : sans ce flag, Claude Code
# refuse de démarrer (c'est le signal « je suis dans un bac à sable délibéré »).
ENV IS_SANDBOX=1
# Pas de mise à jour automatique en plein milieu d'une nuit.
ENV DISABLE_AUTOUPDATER=1

WORKDIR /work
