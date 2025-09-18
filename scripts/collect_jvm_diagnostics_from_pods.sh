#!/bin/bash
# for collecting diagnostics from multiple pods that match a label
# usage example: collect_jvm_diagnostics_from_pods.sh -l component=proxy -A
#                - this collects diagnostics from all Pulsar proxy pods in any namespace
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
script_args=()
if [[ "$1" == "--no-heapdump" ]]; then
    script_args+=("$1")
    shift
fi
while read -r namespace name; do
    "$SCRIPT_DIR"/collect_jvm_diagnostics_from_pod.sh "${script_args[@]}" -n "$namespace" pod/"$name" 
done < <(kubectl get "$@" pods --no-headers -o custom-columns=":metadata.namespace,:metadata.name")