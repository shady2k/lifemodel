#!/bin/sh
# tracker-sync-service.sh — install and start this machine's tracker sync as a
# systemd --user service (docs/backlog-integration.md, Tracker synchronization).
#
#   sh scripts/tracker-sync-service.sh install   render the unit from
#       .backlog/sync/supervisors/systemd-user/tracker-sync.service, running the
#       mechanism copy of the checkout it is run from (the main checkout, once
#       the copy is on main), link it into ~/.config/systemd/user and start it
#   sh scripts/tracker-sync-service.sh status    whether it is installed and running
#
# It changes what runs on the machine, so nothing runs it but a person who
# decided to: npm run connect only checks that the sync is up and names this
# script when it is not. Keeping the service after logout and reboot needs the
# user's linger: loginctl enable-linger "$USER" (may need sudo).
set -eu

unit=lifemodel-tracker-sync.service
top=$(git rev-parse --show-toplevel)
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
state="${XDG_STATE_HOME:-$HOME/.local/state}/$(basename "$main")"
dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

case "${1:-}" in
    install)
        command -v systemctl >/dev/null 2>&1 || {
            printf 'tracker-sync-service: no systemctl here; run the sync by hand instead: node .backlog/sync/tracker-sync.mjs watch\n' >&2
            exit 2
        }
        node=$(command -v node) || { printf 'tracker-sync-service: node is not on PATH\n' >&2; exit 2; }
        mkdir -p "$dir"
        sed -e "s|<project>|lifemodel|" \
            -e "s|<the project's integration, the Tracker synchronization field>|file://$main/docs/backlog-integration.md|" \
            -e "s|WorkingDirectory=<repo>|WorkingDirectory=$main|" \
            -e "s|^ExecStart=.*|ExecStart=$node $top/.backlog/sync/tracker-sync.mjs watch --interval 10 --debounce 2 --max-age 5 --recipe $top/.backlog/sync/trackers/br.mjs --repo $main --state $state|" \
            "$top/.backlog/sync/supervisors/systemd-user/tracker-sync.service" > "$dir/$unit"
        systemctl --user daemon-reload
        systemctl --user enable --now "$unit"
        systemctl --user is-active "$unit"
        if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
            printf 'note: linger is off, so the sync stops at logout and starts again only at your next login: sudo loginctl enable-linger %s\n' "$(id -un)" >&2
        fi
        ;;
    status)
        [ -f "$dir/$unit" ] || { printf 'not installed (%s)\n' "$dir/$unit"; exit 1; }
        systemctl --user is-active "$unit"
        ;;
    *)
        printf 'usage: sh scripts/tracker-sync-service.sh install|status\n' >&2
        exit 2
        ;;
esac
