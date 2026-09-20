#!/usr/bin/env bash
# Installe ou met à jour le démon unused sur une machine Debian/Ubuntu (Pi
# compris), à partir d'une copie du dépôt dans /opt/unused.
#
#   sudo deploy/install.sh
#
# Idempotent : relançable après chaque mise à jour du code. Ne touche pas à
# .env, data/ ni tasks/. Prérequis : node ≥ 22 et docker installés.
set -euo pipefail

DIR=/opt/unused
USER_NAME=unused
UNIT=/etc/systemd/system/unused.service

[ "$(id -u)" -eq 0 ] || { echo "à lancer avec sudo" >&2; exit 1; }
[ -f "$DIR/package.json" ] || { echo "$DIR ne contient pas le dépôt" >&2; exit 1; }
command -v node >/dev/null || { echo "node introuvable (≥ 22 requis)" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker introuvable" >&2; exit 1; }

# L'utilisateur du service : sans shell, membre de docker (équivalent root sur
# l'hôte — acceptable sur une machine dédiée, à savoir).
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin --groups docker "$USER_NAME"
  echo "utilisateur $USER_NAME créé"
fi

cd "$DIR"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund

# Le code appartient au compte qui déploie (git pull sans sudo) ; le service ne
# peut que le lire. Seuls data/ et tasks/ lui sont ouverts en écriture.
OWNER=$(stat -c %U "$DIR/package.json")
mkdir -p data tasks
chown -R "$OWNER:$USER_NAME" "$DIR"
chmod -R g+rX,o-rwx "$DIR"
chown -R "$USER_NAME:$USER_NAME" data tasks
chmod 770 data tasks
if [ -f .env ]; then
  chown "$USER_NAME:$USER_NAME" .env
  chmod 600 .env
else
  echo "ATTENTION : pas de .env — le démon refusera de travailler sans CLAUDE_CODE_OAUTH_TOKEN" >&2
fi

# La CLI pour tous : un wrapper (tsc ne pose pas le bit exécutable), et le
# socket via UNUSED_SOCKET, sans lire la config.
rm -f /usr/local/bin/unused  # un ancien lien symbolique écrirait dans dist/
cat > /usr/local/bin/unused <<WRAPPER
#!/bin/sh
exec node "$DIR/dist/cli.js" "\$@"
WRAPPER
chmod 755 /usr/local/bin/unused
cat > /etc/profile.d/unused.sh <<'PROFILE'
export UNUSED_SOCKET=/opt/unused/data/unused.sock
PROFILE

cp deploy/unused.service "$UNIT"
systemctl daemon-reload
systemctl enable unused >/dev/null
if systemctl is-active --quiet unused; then
  systemctl restart unused
  echo "service redémarré"
else
  systemctl start unused
  echo "service démarré"
fi
sleep 1
systemctl --no-pager --lines=3 status unused || true
echo
echo "Pour piloter depuis ce compte : ajoute-toi au groupe docker (sudo usermod -aG docker \$USER, puis reconnexion),"
echo "puis : unused status · unused docker build · unused tasks list"
