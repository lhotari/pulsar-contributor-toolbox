#!/bin/bash
command="$1"
shift
while read -r namespace name; do
    echo "Executing on $namespace pod/$name"
    kubectl exec -n "$namespace" pods/"$name" -q -- bash -c "$command"
done < <(kubectl get pods "$@" --no-headers -o custom-columns=":metadata.namespace,:metadata.name")
