#!/bin/sh
# Regenerate the resolv.conf k3s reads, then make the pods that copied the old
# nameservers take the new ones (lifemodel-s9v5.1.5).
#
# Both install paths run this file: the NixOS module's
# lifemodel-k3s-resolv.service and the generic-Linux installer's unit of the
# same name. It runs before k3s starts, and again whenever the host's DNS
# changes, from the lifemodel-k3s-resolv.path unit.
#
# CoreDNS runs with dnsPolicy Default, so it forwards to the nameservers of the
# resolv.conf copied into its pod when it was created; every other pod asks
# CoreDNS. Recreating CoreDNS's pods is therefore what makes a host DNS change
# reach the cluster. A cluster that is not up yet needs nothing: it reads the
# file this script has just written when it starts.
#
# The SOURCE list is the one k3s itself reads, in its order: the host's own
# resolv.conf, then systemd-resolved's list of real upstream servers (its stub
# file holds only 127.0.0.53, which no pod can use).
#
# Usage: k3s-resolv.sh GENERATOR TARGET SOURCE [SOURCE...]
set -eu
usage='usage: k3s-resolv.sh GENERATOR TARGET SOURCE [SOURCE...]'
generator=${1:?$usage}
target=${2:?$usage}
shift 2
[ "$#" -gt 0 ] || { printf '%s\n' "$usage" >&2; exit 2; }

change=$(node "$generator" "$target" "$@")
[ "$change" = changed ] || exit 0
systemctl is-active --quiet k3s.service || exit 0
k3s kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n kube-system delete pod -l k8s-app=kube-dns --wait=false
