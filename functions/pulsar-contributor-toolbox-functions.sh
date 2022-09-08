# shell functions for working with Pulsar development
# zsh and bash are supported

if [ -z "$PULSAR_CONTRIBUTOR_TOOLBOX" ]; then
  if [ -n "$BASH_SOURCE" ]; then
    PULSAR_CONTRIBUTOR_TOOLBOX=$(dirname $BASH_SOURCE)
  else
    # zsh
    PULSAR_CONTRIBUTOR_TOOLBOX=${0:a:h}
  fi
  PULSAR_CONTRIBUTOR_TOOLBOX=$(dirname $PULSAR_CONTRIBUTOR_TOOLBOX)
fi

PTBX_DEFAULT_DOCKER_REPO_PREFIX="lhotari"
PTBX_DEFAULT_DOCKER_IMAGE_PREFIX="pulsar"
PTBX_DEFAULT_JAVA_TEST_IMAGE_NAME="java-test-image"

if [ -f "$HOME/.pulsar_contributor_toolbox" ]; then
  source "$HOME/.pulsar_contributor_toolbox"
fi

# alias for refreshing changes
if [ -n "$BASH_SOURCE" ]; then
  alias ptbx_refresh="source $BASH_SOURCE"
else
  # zsh
  alias ptbx_refresh="source ${0:a}"
fi

# add bin directory to path
export PATH="$PULSAR_CONTRIBUTOR_TOOLBOX/bin:$PATH"

# runs license checks
function ptbx_run_license_check() {
  (
    ptbx_cd_git_root
    mvn -ntp -DskipTests initialize license:check
  )
}

# runs license checks and checkstyle
function ptbx_run_quick_check() {
  (
    mvn -ntp -T 1C -DskipSourceReleaseAssembly=true -DskipBuildDistribution=true -Dspotbugs.skip=true verify -DskipTests "$@"
  )
}

function ptbx_build_coremodules() {
  (
    ptbx_cd_git_root
    ptbx_clean_snapshots
    mvn -Pcore-modules,-main -T 1C clean install -DskipTests -Dspotbugs.skip=true "$@"
  )
}

function ptbx_build_all() {
  (
    ptbx_cd_git_root
    ptbx_clean_snapshots
    command mvn -T 1C clean install -DskipTests -Dspotbugs.skip=true -DShadeTests -DintegrationTests -DBackwardsCompatTests -Dtest=NoneTest -DfailIfNoTests=false "$@"
  )
}

function ptbx_build_inttests() {
  (
    ptbx_cd_git_root
    ptbx_clean_snapshots
    command mvn -T 1C clean install -DskipTests -Dspotbugs.skip=true -DintegrationTests -Dtest=NoneTest -DfailIfNoTests=false -am -pl tests/integration "$@"
  )
}

function ptbx_build_server_distribution() {
  (
    ptbx_build_server_distribution_full -Pcore-modules,-main "$@"
  )
}

function ptbx_server_distribution_license_check() {
  (
    ptbx_build_server_distribution
    ptbx_cd_git_root
    src/check-binary-license --no-presto ./distribution/server/target/apache-pulsar-*-bin.tar.gz
  )
}

function ptbx_build_server_distribution_full() {
  (
    ptbx_cd_git_root
    ptbx_clean_snapshots
    command mvn -T 1C clean install -Dmaven.test.skip=true -DskipSourceReleaseAssembly=true -Dspotbugs.skip=true -Dlicense.skip=true -pl distribution/server -am "$@"
  )
}

function ptbx_server_distribution_license_check_full() {
  (
    ptbx_build_server_distribution_full
    ptbx_cd_git_root
    src/check-binary-license ./distribution/server/target/apache-pulsar-*-bin.tar.gz
  )
}

function ptbx_clean_snapshots() {
  (
    if [ -n "$ZSH_NAME" ]; then
      setopt nonomatch
    fi
    ls -d ~/.m2/repository/{org/apache,com/datastax/oss}/pulsar/**/"$(ptbx_project_version)" 2>/dev/null | xargs -r rm -rf
  )
}

function ptbx_clean_cppbuild() {
  (
    ptbx_cd_git_root
    cd pulsar-client-cpp
    if [ -n "$(find '!' -user $USER)" ]; then
      sudo chown -R $USER:$GROUP .
    fi
    git clean -fdx
  )
}

# runs a command until it fails
function ptbx_untilfail() {
  (
    while $@; do :; done
  )
}

# runs a command within docker to limit cpu and memory
function ptbx_docker_run() {
  (
    local cpus=2
    local memory=6g
    while [ true ]; do
      if [[ "$1" =~ --cpus=.* ]]; then
        cpus="${1#*=}"
        shift
      elif [[ "$1" =~ --memory=.* ]]; then
        memory="${1#*=}"
        shift
      else
        break
      fi
    done
    additional_groups=()
    for gid in $(id -G); do
      additional_groups+=("--group-add=$gid")
    done
    docker run --cpus=$cpus --memory=$memory -u "$UID:${GID:-"$(id -g)"}" "${additional_groups[@]}" --net=host -it --rm -v $HOME:$HOME -v /var/run/docker.sock:/var/run/docker.sock -w $PWD -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro ubuntu "$@"
  )
}

# runs a command with sdkman initialized in the docker container
function ptbx_docker_run_with_sdkman {
  ptbx_docker_run bash -c 'source $HOME/.sdkman/bin/sdkman-init.sh; "$@"' bash "$@"
}

# runs tests with docker to limit cpu & memory, in a loop until it fails
# it is assumed that sdkman is used for JDK management. the default JDK version will be used within docker.
# example: ptbx_until_test_fails_in_docker -Pcore-modules,-main -pl pulsar-broker -Dtest=TopicReaderTest
function ptbx_until_test_fails_in_docker() {
  (
    local cpus=2
    local memory=6g
    while [ true ]; do
      if [[ "$1" =~ --cpus=.* ]]; then
        cpus="${1#*=}"
        shift
      elif [[ "$1" =~ --memory=.* ]]; then
        memory="${1#*=}"
        shift
      else
        break
      fi
    done
    ptbx_docker_run --cpus=$cpus --memory=$memory \
      bash -c "source \$HOME/.sdkman/bin/sdkman-init.sh
    $(ptbx_until_test_fails_script)" bash "$@"
  )
}

function ptbx_until_test_fails_in_docker_with_logs() {
  (
    ptbx_until_test_fails_in_docker "$@" |& ptbx_tee_to_output_log
  )
}

function ptbx_until_test_fails() {
  (
    bash -c "$(ptbx_until_test_fails_script)" bash "$@"
  )
}

function ptbx_until_test_fails_with_logs() {
  (
    ptbx_until_test_fails "$@" |& ptbx_tee_to_output_log
  )
}

function ptbx_until_test_fails_script() {
  cat <<'EOF'
counter=1
while mvn -DredirectTestOutputToFile=false -DtestRetryCount=0 test "$@"; do
  echo "----------- LOOP $counter ---------------"
  ((counter++))
done
echo "Exited after loop #$counter"
EOF
}

function ptbx_run_test() {
  (
    mvn -DredirectTestOutputToFile=false -DtestRetryCount=0 test "$@"
  )
}

function ptbx_tee_to_output_log() {
  tee "output_$(ptbx_datetime).log"
}

# prints a date & time up to second resolution
function ptbx_datetime() {
  date +%Y-%m-%d-%H%M%S
}

# changes the working directory to the Pulsar source code directory set by PULSAR_DEV_DIR
function ptbx_cd_pulsar_dir {
  if [ -n "$PULSAR_DEV_DIR" ]; then
    cd "$PULSAR_DEV_DIR"
  else
    ptbx_cd_git_root
  fi
}

function ptbx_cd_git_root {
  local gitdir=$(git rev-parse --show-toplevel)
  [ ! -d "$gitdir" ] && echo "Not a git directory" && return 1
  cd "$gitdir"
}

# creates a local git working directory that can git pull from the actual working directory
# this is useful for running tests in the background
function ptbx_local_clone_create() {
  (
    set -e
    echo "setup local clone"
    GITDIR=$(git rev-parse --show-toplevel)
    [ ! -d "$GITDIR" ] && echo "Not a git directory" && exit 1
    CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    REPONAME=$(basename $GITDIR)
    parentdir=$(dirname $GITDIR)
    CLONEDIR="$parentdir/$REPONAME.testclone"
    [ -d "$CLONEDIR" ] && echo "Clone already exists" && exit 1
    git worktree add --detach $CLONEDIR $CURRENTBRANCH
    cd "$CLONEDIR"
    echo "Clone created in $(pwd)"
  )
}

# changes to the "testclone" directory
function ptbx_local_clone_cd() {
  ptbx_cd_pulsar_dir
  CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
  REPONAME=$(basename $PWD)
  parentdir=$(dirname $PWD)
  CLONEDIR="$parentdir/$REPONAME.testclone"
  [ ! -d "$CLONEDIR" ] && ptbx_local_clone_create
  cd $CLONEDIR
}

# pushes all changes to repository named "forked"
# useful when calling the github fork of a repository "forked"
function ptbx_gitpush_to_forked() {
  (
    CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    if [ -n "$CURRENTBRANCH" ]; then
      git push -f forked "$CURRENTBRANCH:$CURRENTBRANCH"
    fi
  )
}

# synchronizes the forked/master remote branch with origin/master
function ptbx_git_sync_forked_master_with_upstream() {
  (
    git fetch origin
    git update-ref refs/heads/master origin/master
    git push -f forked master
  )
}

function _ptbx_git_sync_branches() {
  (
    local remote=$1
    shift
    local -a branches=("${@}")
    git fetch $remote
    for branch in "${branches[@]}"; do
      local current_branch="$(git branch --show-current)"
      if [[ $branch == $current_branch ]]; then
        git checkout --detach HEAD
      fi
      git update-ref refs/heads/$branch $remote/$branch
      if [[ $branch == $current_branch ]]; then
        git checkout $branch
      fi
    done
  )
}


function ptbx_git_sync_pulsar_maintenance_branches_with_upstream() {
  (
    cd ~/workspace-pulsar/pulsar
    _ptbx_git_sync_branches origin master branch-2.7 branch-2.8 branch-2.9 branch-2.10
    cd ~/workspace-pulsar/pulsar.datastax
    _ptbx_git_sync_branches datastax 2.7.2_ds 2.8.0_ds 2.8.3_ds
  )
}



# generates ssh config file for connecting to running vms managed by https://multipass.run/
# this is useful for using rsync to copy files to/from multipass vm
# prerequisite: copy the multipass ssh key:
# sudo cp /var/snap/multipass/common/data/multipassd/ssh-keys/id_rsa ~/.ssh/multipass_id_rsa
# sudo chown $USER:$GROUP ~/.ssh/multipass_id_rsa
# ssh-keygen -y -f ~/.ssh/multipass_id_rsa > ~/.ssh/multipass_id_rsa.pub
function ptbx_multipass_update_sshconfig() {
  (
    echo 'Host *.multipass
  User ubuntu
  IdentityFile ~/.ssh/multipass_id_rsa
  IdentitiesOnly yes
  UserKnownHostsFile /dev/null
  StrictHostKeyChecking no
  PasswordAuthentication no
'
    IFS='
'
    for vm in $(multipass ls --format csv | grep Running); do
      echo "Host $(echo $vm | awk -F , '{ print $1 }').multipass
  Hostname $(echo $vm | awk -F , '{ print $3 }')
"
    done
  ) >~/.ssh/multipass_ssh_config
  echo 'Updated ~/.ssh/sshconfig_multipass. use "Include ~/.ssh/multipass_ssh_config" to include it in ~/.ssh/config'
}

# creates a multipass vm and installs docker in it
function ptbx_multipass_create_vm_with_docker() {
  local vmname="$1"
  [ -n "$vmname" ] || {
    echo "Pass VM name as argument"
    return 1
  }
  (
    multipass launch -d 20G -n $vmname
    echo 'export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get -y install docker.io
sudo adduser ubuntu docker
' | multipass shell $vmname
  )
}

function ptbx_multipass_copy_ssh_key() {
  (
    sudo cp /var/snap/multipass/common/data/multipassd/ssh-keys/id_rsa ~/.ssh/multipass_id_rsa
    sudo chown $USER:$GROUP ~/.ssh/multipass_id_rsa
    chmod 0600 ~/.ssh/multipass_id_rsa
    ssh-keygen -y -f ~/.ssh/multipass_id_rsa >~/.ssh/multipass_id_rsa.pub
  )
}

# workaround for https://github.com/canonical/multipass/issues/1866
function ptbx_multipass_fix_network() {
  (
    for table in filter nat mangle; do
      sudo iptables-legacy -t $table -S | grep Multipass | xargs -L1 sudo iptables-nft -t $table
    done
  )
}

function ptbx_multipass_delete() {
  (
    local name="$1"
    multipass stop "$name" && multipass delete "$name" && multipass purge
  )
}

# changing cpus or memory for multipass vm
# https://github.com/canonical/multipass/issues/1158#issuecomment-577315005
function ptbx_multipass_edit_config() {
  sudo bash -c 'systemctl stop snap.multipass.multipassd.service;vi /var/snap/multipass/common/data/multipassd/multipassd-vm-instances.json;systemctl start snap.multipass.multipassd.service'
}

# uploads a maven build log file as a gist, converting to plain text (remove ansi code)
function ptbx_upload_log_to_gist() {
  (
    local filename="$1"
    shift
    if [ ! -f "$filename" ]; then
      echo "File '${filename}' doesn't exist."
      echo "usage: ptbx_upload_log_to_gist [filename] -d [description]"
      exit 1
    fi
    cat "$filename" | ansi2txt >"${filename}.txt"
    gh gist create "${filename}.txt" "$@"
  )
}

function ptbx_project_version() {
  # prints out the project version and nothing else
  # https://maven.apache.org/plugins/maven-help-plugin/evaluate-mojo.html#forceStdout
  mvn initialize help:evaluate -Dexpression=project.version -pl . -q -DforceStdout | sed 's/\[INFO\] \[stdout\] //' | grep -F -v '[WARN]' | tail -1
}

function ptbx_build_docker_pulsar_all_image() {
  (
    docker pull ubuntu:20.04
    ptbx_clean_cppbuild
    command mvn clean install -Dspotbugs.skip=true -DskipTests
    command mvn -f docker/pulsar/pom.xml install -am -Pdocker,-main -DskipTests
    command mvn -f docker/pulsar-all/pom.xml install -am -Pdocker,-main -DskipTests
  )
}

function ptbx_build_test_latest_version_image() {
  (
    ptbx_build_docker_pulsar_all_image
    command mvn -B -f tests/docker-images/pom.xml install -am -Pdocker -Dspotbugs.skip=true -DskipTests
  )
}

function ptbx_build_pulsar_all_and_push_to_microk8s() {
  (
    ptbx_build_and_push_pulsar_images localhost:32000/apachepulsar
  )
}

function ptbx_build_and_push_pulsar_images() {
  (
    ptbx_build_docker_pulsar_all_image || return 1
    ptbx_push_pulsar_images "$@"
  )
}

function ptbx_push_pulsar_images() {
  (
    docker_repo_prefix=${1:-"$PTBX_DEFAULT_DOCKER_REPO_PREFIX"}
    docker_tag="$2"
    docker_repo_image_prefix=${3:-"$PTBX_DEFAULT_DOCKER_IMAGE_PREFIX"}
    if [[ -z "$docker_tag" ]]; then
      gitrev=$(git rev-parse HEAD | colrm 10)
      project_version=$(ptbx_project_version)
      docker_tag="${project_version}-$gitrev"
    fi
    set -xe
    docker tag apachepulsar/pulsar-all:latest ${docker_repo_prefix}/${docker_repo_image_prefix}-all:${docker_tag}
    docker tag apachepulsar/pulsar:latest ${docker_repo_prefix}/${docker_repo_image_prefix}:${docker_tag}
    docker push ${docker_repo_prefix}/${docker_repo_image_prefix}-all:${docker_tag}
    docker push ${docker_repo_prefix}/${docker_repo_image_prefix}:${docker_tag}
  )
}

function ptbx_push_pulsar_all_with_openid_connect_plugin() {
  (
    docker_repo_prefix=${1:-"$PTBX_DEFAULT_DOCKER_REPO_PREFIX"}
    docker_tag="$2"
    docker_repo_image_prefix=${3:-"$PTBX_DEFAULT_DOCKER_IMAGE_PREFIX"}
    TEMP_DIR="$(mktemp -d)"
    mkdir "$TEMP_DIR/extra-jars"
    cd "$TEMP_DIR/extra-jars"
    curl -L -O https://github.com/datastax/pulsar-openid-connect-plugin/releases/download/1.0.0-beta/pulsar-openid-connect-plugin-1.0.0-beta.jar
    cd "$TEMP_DIR"
    cat >Dockerfile <<EOF
FROM apachepulsar/pulsar-all:latest

# COPY extra jars
COPY --chown=pulsar:0 extra-jars/*.jar /pulsar/lib/
EOF
    docker build -t ${docker_repo_prefix}/${docker_repo_image}:${docker_tag} .
    docker push ${docker_repo_prefix}/${docker_repo_image}:${docker_tag}
  )
}

function ptbx_build_and_push_java_test_image_to_microk8s() {
  (
    ptbx_build_and_push_java_test_image localhost:32000/apachepulsar
  )
}

function ptbx_build_and_push_java_test_image() {
  (
    docker pull ubuntu:20.04
    ptbx_cd_git_root
    ./build/build_java_test_image.sh || return 1
    docker_repo_prefix=${1:-"$PTBX_DEFAULT_DOCKER_REPO_PREFIX"}
    gitrev=$(git rev-parse HEAD | colrm 10)
    project_version=$(ptbx_project_version)
    docker_tag="${project_version}-$gitrev"
    set -xe
    docker tag apachepulsar/java-test-image:latest ${docker_repo_prefix}/${PTBX_DEFAULT_JAVA_TEST_IMAGE_NAME}:${docker_tag}
    docker push ${docker_repo_prefix}/${PTBX_DEFAULT_JAVA_TEST_IMAGE_NAME}:${docker_tag}
  )
}

function ptbx_forked_repo() {
  ptbx_gh_slug forked
}

function ptbx_gh_slug() {
  local repo="$(git remote get-url "$1")"
  repo="${repo##*github.com/}"
  repo="${repo%.*}"
  echo "$repo"
}

function ptbx_github_open_pr_to_own_fork() {
  gh pr create "--repo=$(ptbx_forked_repo)" --base master --head "$(git branch --show-current)" -f "$@"
}

function ptbx_github_open_pr() {
  local github_user="$(ptbx_forked_repo)"
  github_user="${github_user%/*}"
  gh pr create "--repo=$(ptbx_gh_slug origin)" --base master --head "$github_user:$(git branch --show-current)" -w
}

function ptbx_reset_iptables() {
  (
    sudo su <<'EOF'
  for iptables_bin in iptables iptables-legacy; do
    $iptables_bin -F
    $iptables_bin -X
    $iptables_bin -t nat -F
    $iptables_bin -t nat -X
    $iptables_bin -t mangle -F
    $iptables_bin -t mangle -X
    $iptables_bin -P INPUT ACCEPT
    $iptables_bin -P FORWARD ACCEPT
    $iptables_bin -P OUTPUT ACCEPT
  done
EOF
  )
}

# shows the tracking branch name, usually origin/master
function ptbx_git_upstream_branch() {
  git rev-parse --abbrev-ref master@{upstream}
}

# soft resets all changes to the upstream, useful for re-committing changes in a branch
function ptbx_reset_to_merge_base_in_upstream() {
  git reset "$(git merge-base $(ptbx_git_upstream_branch) HEAD)" "$@"
}

# helper for re-committing changes in a branch
# this is an alternative way for squashing commits
# prerequisite is to first reset all commits in the branch with ptbx_reset_to_merge_base
function ptbx_commit_based_on_reference() {
  local sha=$1
  # add same files
  git log --format="" -n 1 --stat --name-only $sha | xargs git add -f
  # copy commit message
  git commit --no-edit --reuse-message=$sha "$@"
}

function _ptbx_extract_threaddumps() {
  ansi2txt | colrm 1 29 | csplit - -f threadump$(date -I)_ -b %02d.txt --suppress-matched -z '/----------------------- pid/' '{*}'
}

function ptbx_extract_threaddumps() {
  local FILE="${1:-"$(find -name "*_print\ JVM\ thread\ dumps\ when\ cancelled.txt" -print -quit)"}"
  cat "$FILE" | _ptbx_extract_threaddumps
}

function ptbx_extract_threaddumps_from_zip() {
  local ZIPFILE=$1
  unzip -p $ZIPFILE "*print JVM thread dumps*" | _ptbx_extract_threaddumps
}

function ptbx_search_jars() {
  (
    if [ $ZSH_VERSION ]; then
      setopt sh_word_split
    fi
    IFS=$'\n'
    JARFILES=$(find -name "*.jar")
    for i in $JARFILES; do
      RESULTS=$(unzip -Z -1 -C "$i" "$1" 2>/dev/null)
      if [ -n "$RESULTS" ]; then
        echo Results in $i
        echo "${RESULTS}"
      fi
    done
  )
}

function ptbx_cherrypick_branch() {
  (
    set -xe
    branch="$1"
    target_branch="$2"
    source_trunk="${3:-master}"
    temp_branch="tempbranch$$"
    git branch "$temp_branch" "$branch"
    git rebase --onto "${target_branch}" "$(git merge-base "${source_trunk}" "${branch}")" "${temp_branch}"
    git checkout "${target_branch}"
    git merge --squash "$temp_branch"
    git branch -D "$temp_branch"
  )
}

function ptbx_mvn_publish_to_apache_repository() {
  (
    [ -f ~/.m2/apache-settings.xml ] || curl -o ~/.m2/apache-settings.xml https://raw.githubusercontent.com/apache/pulsar/master/src/settings.xml
    export APACHE_USER="${APACHE_USER:-$USER}"
    stty -echo
    printf "Password: "
    read APACHE_PASSWORD
    stty echo
    printf "\n"
    export APACHE_PASSWORD
    export GPG_TTY=$(tty)
    mvn deploy -DskipTests --settings ~/.m2/apache-settings.xml
  )
}

function ptbx_copy_docker_image_to_microk8s() {
  (
    source_image=$1
    target_image=localhost:32000/$1
    docker tag $source_image $target_image
    docker push $target_image
    CTR="ctr -a /var/snap/microk8s/common/run/containerd.sock -n k8s.io"
    sudo bash -c "$CTR images pull --plain-http $target_image && $CTR images tag $target_image $source_image docker.io/$source_image"
  )
}

function ptbx_kubectl_check_auth() {
  (
    for resource in "$@"; do
      for verb in create get list watch update patch delete deletecollection; do
        echo "$resource $verb $(kubectl auth can-i $verb $resource)"
      done
    done
  )
}


function ptbx_list_images_in_ds_pulsar_values() {
  (
    values_file="$HOME/workspace-datastax/datastax-pulsar-helm-chart/helm-chart-sources/pulsar/values.yaml"
    yq e '.image | .[] |= ([.repository, .tag] | join(":")) | to_entries | .[] | .value' "$values_file" | sort | uniq
  )
}

function ptbx_crc_ssh() {
  ssh -i "$HOME/.crc/machines/crc/id_ecdsa" core@192.168.130.11 "$@"
}

function ptbx_copy_docker_image_to_crc() {
  (
    source_image="$1"
    target_image="default-route-openshift-image-registry.apps-crc.testing/$(oc project -q)/${source_image#*/}"
    docker tag "$source_image" "$target_image"
    docker login -u kubeadmin -p "$(oc whoami -t)" default-route-openshift-image-registry.apps-crc.testing
    docker push "$target_image"
    ptbx_crc_ssh sudo podman login -u kubeadmin -p "$(oc whoami -t)" default-route-openshift-image-registry.apps-crc.testing --tls-verify=false
    ptbx_crc_ssh sudo podman image pull --tls-verify=false "$target_image"
    ptbx_crc_ssh sudo podman image tag "$target_image" "$source_image"
    ptbx_crc_ssh sudo podman image tag "$target_image" "docker.io/$source_image"
  )
}

function ptbx_copy_ds_helm_chart_images_to_crc() {
  (
    for image in $(ptbx_list_images_in_ds_pulsar_values); do
      ptbx_copy_docker_image_to_crc "$image"
    done
  )
}

function _ptbx_upload_encrypted() {
  local file_name="$1"
  local recipient="$2"
  gpg -k "$recipient" &> /dev/null || gpg --recv-key "$recipient" &> /dev/null || { echo "Searching for key for $recipient"; gpg --search-keys "$recipient"; }
  local transfer_url=$(gpg --encrypt --recipient "$recipient" --trust-model always \
    |curl --progress-bar --upload-file "-" "https://transfer.sh/${file_name}.gpg" \
    |tee /dev/null)
  echo ""
  echo "command for receiving: curl $transfer_url | gpg --decrypt > ${file_name}"
}

function ptbx_transfer(){
    if [ "$1" == "--desc" ]; then
    echo "Transfers files with gpg encryption over transfer.sh"
    return 0
  fi
  if [ $# -lt 2 ]; then
      echo "No arguments specified.\nUsage:\n ptbx_transfer <file|directory> recipient\n ... | ptbx_transfer <file_name> recipient">&2
      return 1
  fi
  if tty -s; then
    local file="$1"
    local recipient="$2"
    local file_name=$(basename "$file")
    if [ ! -e "$file" ]; then
      echo "$file: No such file or directory">&2
      return 1
    fi
    if [ -d "$file" ]; then
        file_name="${file_name}.tar.gz"
        tar zcf - "$file" | _ptbx_upload_encrypted $file_name $recipient
    else
        cat "$file" | _ptbx_upload_encrypted $file_name $recipient
    fi
  else
    local file_name=$1
    local recipient="$2"
    _ptbx_upload_encrypted $file_name $recipient
  fi
}

function ptbx_transfer_unencrypted() { 
  if [ $# -eq 0 ];then
    echo "No arguments specified.\nUsage:\n ptbx_transfer_unencrypted <file|directory>\n ... | ptbx_transfer_unencrypted <file_name>">&2
    return 1
  fi
  if tty -s; then
    file="$1"
    file_name=$(basename "$file")
    if [ ! -e "$file" ];then
      echo "$file: No such file or directory">&2
      return 1
    fi
    if [ -d "$file" ]; then
      file_name="$file_name.zip"
      (cd "$file" && zip -r -q - .)|curl --progress-bar --upload-file "-" "https://transfer.sh/$file_name"|tee /dev/null
    else 
      cat "$file"|curl --progress-bar --upload-file "-" "https://transfer.sh/$file_name"|tee /dev/null
    fi
  else 
    file_name=$1;curl --progress-bar --upload-file "-" "https://transfer.sh/$file_name"|tee /dev/null
  fi
  echo ""
}

function ptbx_show_latest_chart() {
  : "${2?' usage: ptbx_show_latest_chart [charturl] [chart]'}"
  local charturl=$1
  local chart=$2
  curl -s "${charturl}/index.yaml" | yq -o json eval |jq --arg chart "$chart" -r '.entries[$chart] | .[] | .version' | sort -n | tail -1
}

function ptbx_untar_latest_snapshot (){
    (
        ptbx_cd_git_root
        local TARGET_DIR="./distribution/server/target"
        local latest_generated_ss="$(ls -dt ${TARGET_DIR}/apache-pulsar-*-SNAPSHOT-bin.tar.gz | head -1)"
        tar -xvf "$latest_generated_ss" -C "${TARGET_DIR}"
    )
}

function ptbx_use_latest_snapshot_bin (){
    {
        ptbx_cd_git_root
        local TARGET_DIR="distribution/server/target"
        local latest_generated_ss="$(ls -dt ${TARGET_DIR}/apache-pulsar-*-SNAPSHOT | head -1)"
        echo "Run the following to use the binary in the latest snapshot"
        echo $latest_generated_ss
        export PULSAR_BIN="${PWD}/${latest_generated_ss}/bin"
        echo -e "\t\texport PATH=\${PATH}:${PULSAR_BIN}"
    }
}

# assumes there is only one path to a snapshot bin in PATH
function ptbx_remove_latest_snapshot_bin (){
    if [[ ! -z $PULSAR_BIN ]]; then
        echo "To remove latest pulsar bin from PATH, run:"
        echo "export PATH=${PATH%%:${PULSAR_BIN}*}${PATH##*${PULSAR_BIN}}"
        unset PULSAR_BIN
    else
        echo "PULSAR_BIN not set, nothing to remove"
    fi
}


function ptbx_add_debug_opts_to_configmap() {
  (
    local ns=pulsar
    # namespace can be defined with "-n" parameter, for example "-n cluster-a"
    if [[ $1 == "-n" ]]; then
      shift
      ns=$1
      shift
    fi
    local component="${1:-broker}"
    local suspend="${2:-n}"
    set -e
    local configmap=$(kubectl get -n $ns -l "component=${component}" configmap -o=name)
    local cmjson="$(kubectl get -n $ns -o json $configmap)"
    local current_opts=$(printf '%s' "$cmjson" | jq -r '.data.PULSAR_EXTRA_OPTS // ""' | perl -p -e 's/-agentlib.*?(\s|$)//')
    printf '%s' "$cmjson" |
        jq --arg newcontent "$current_opts -agentlib:jdwp=transport=dt_socket,server=y,suspend=${suspend},address=*:5005" '.data.PULSAR_EXTRA_OPTS |= $newcontent' |
        kubectl replace -n $ns -f -
  )
}

# tails logs on all pods that match the kubectl get "query"
# example usage: ptbx_k_logs -n cluster-a -l component=broker | grep ERROR
function ptbx_k_logs() {
  {
    while read -r namespace name; do
      printf "kubectl logs -f -n %s pod/%s | sed -e 's/^/[%s] /'\0" "$namespace" "$name" "$name"
    done < <(kubectl get "$@" pods --no-headers -o custom-columns=":metadata.namespace,:metadata.name")
  } | xargs -0 parallel --
}

function ptbx_k_debug_portfw() {
  {
    local port=5005
    # starting port can be defined with "-p" parameter, for example "-p 5010"
    if [[ $1 == "-p" ]]; then
      shift
      port=$1
      shift
    fi
    while read -r namespace name; do
      printf "kubectl port-forward -n %s pod/%s %s:5005\0" "$namespace" "$name" "$port"
      >&2 echo "Forwarding local port $port to ns $namespace pod/$name port 5005"
      ((port++))
    done < <(kubectl get "$@" pods --no-headers -o custom-columns=":metadata.namespace,:metadata.name")
  } | xargs -0 parallel --
}

if type mvnd > /dev/null; then
  # delegate all mvn commands to mvnd
  function mvn() {
    mvnd "$@"
  }
fi

function ptbx_cancel_own_fork_runs() {
  for id in $(gh run list -R lhotari/pulsar -L 100 --json databaseId,status -q '.[] | select(.status=="in_progress" or .status=="queued") | .databaseId'); do
    gh run cancel $id -R lhotari/pulsar
  done
}

function ptbx_collect_internal_stats() {
  (
    export PATH="$PATH:/pulsar/bin"
    for topic in $(pulsar-admin topics list-partitioned-topics public/default|xargs echo); do
      file="stats_internal_$(basename "$topic")_$(date +%s).json"
      pulsar-admin topics partitioned-stats-internal "$topic" > "$file"
    done
  )
}

function _github_get() {
  urlpath="$1"
  _github_client -f "https://api.github.com/repos/$(ptbx_gh_slug origin)${urlpath}"
}

function _github_client() {
  curl -s -H "Authorization: token ${GITHUB_TOKEN}" -H "Accept: application/vnd.github.v3+json" "$@"
}

function _get_cancel_urls() {
    run_status="${1:-failure}"
    # API reference https://docs.github.com/en/rest/reference/actions#list-workflow-runs-for-a-repository
    local actionsurl="/actions/runs?branch=${PR_BRANCH}&status=${run_status}&per_page=100"
    if [[ -n "${PR_USER}" && "${PR_USER}" != "any" ]]; then
      actionsurl="${actionsurl}&actor=${PR_USER}"
    fi
    _github_get "$actionsurl" | \
      {
        if [ -n "$HEAD_SHA" ]; then
          jq -r --arg head_sha "${HEAD_SHA}" '.workflow_runs[] | select(.head_sha==$head_sha) | .cancel_url'
        else
          jq -r '.workflow_runs[] | .cancel_url'
        fi
      }
}

function ptbx_cancel_pr_runs() {
  PR_NUM=${1-:1}

  # get head sha
  PR_JSON="$(_github_get "/pulls/${PR_NUM}")"
  HEAD_SHA=$(printf "%s" "${PR_JSON}" | jq -r .head.sha)
  PR_BRANCH=$(printf "%s" "${PR_JSON}" | jq -r .head.ref)
  PR_USER=$(printf "%s" "${PR_JSON}" | jq -r .head.user.login)

  for url in $(_get_cancel_urls in_progress) $(_get_cancel_urls queued); do
    echo "cancelling $url"
    _github_client -X POST "${url}"
  done
}

function ptbx_cancel_branch_runs() {
  PR_BRANCH=${1:-master}
  PR_USER=${2:-lhotari}
  for url in $(_get_cancel_urls in_progress) $(_get_cancel_urls queued); do
    echo "cancelling $url"
    _github_client -X POST "${url}"
  done
}

function ptbx_delete_old_logs() {
  (
  if [ -n "$ZSH_NAME" ]; then
    set -y
  fi
  local page=1
  while true; do  
    urls="$(_github_get "/actions/runs?page=$page&created=$(date -I --date="90 days ago")..$(date -I --date="14 days ago")&per_page=100" | jq -r '.workflow_runs[] | .logs_url')"
    if [ -z "$urls" ]; then
      break
    fi
    for url in $urls; do
      echo "deleting $url"
      _github_client -X DELETE "${url}"
    done
    ((page++))
  done
  )
}

function ptbx_cancel_old_runs() {
  (
  if [ -n "$ZSH_NAME" ]; then
    set -y
  fi
  local page=1
  while true; do  
    urls="$(_github_get "/actions/runs?page=$page&status=queued&created=<$(date -I --date="5 days ago")&per_page=100" | jq -r '.workflow_runs[] | .cancel_url')"
    if [ -z "$urls" ]; then
      break
    fi
    for url in $urls; do
      echo "cancelling $url"
      _github_client -X POST "${url}"
    done
    ((page++))
  done
  )
}

function ptbx_enable_all_workflows() {
  (
  local action=${1:-"enable"}
  if [ -n "$ZSH_NAME" ]; then
    set -y
  fi
  exec {results_fd}< <(_github_get "/actions/workflows?per_page=100" | jq -r '.workflows[] | [.name,.url,.html_url] | @tsv')
  while IFS=$'\t' read -r name url html_url <&${results_fd}; do
    echo "${name} ${html_url}"
    _github_client -X PUT "${url}/${action}"
  done
  )
}


function ptbx_cancel_pending_runs() {
  (
  local skip=${1:-0}
  if [ -n "$ZSH_NAME" ]; then
    set -y
  fi
  local page=1
  while true; do
    exec {runs_fd}< <(_github_get "/actions/runs?page=$page&status=pending&created=<$(date -I --date="3 days ago")&per_page=100" | jq -r '.workflow_runs[] | select(.status=="pending" and .conclusion==null) | [.html_url,.cancel_url] | @tsv')
    local notempty=0
    while IFS=$'\t' read -r html_url cancel_url <&${runs_fd}; do
      notempty=1
      echo "${html_url}"
      if [[ $skip != 1 ]]; then
        _github_client -X POST "${cancel_url}"
      fi
    done
    if [[ $notempty == 0 ]]; then
      break
    fi
    ((page++))
  done
  )
}

function _ptbx_wait_gh_ratelimit() {
  local limits=${1:-100}
  while true; do
    remaining_limit=$(_github_client -I https://api.github.com/user |grep x-ratelimit-remaining | sed 's/\r$//' | awk '{ print $2 }')
    echo "Remaining limits: ${remaining_limit}"
    if [[ $remaining_limit -lt $limits ]]; then
      ratelimit_reset=$(_github_client -I https://api.github.com/user |grep x-ratelimit-reset | sed 's/\r$//' | awk '{ print $2 }')
      wait_seconds=$((ratelimit_reset - $(date +%s) + 10))
      echo "Wait ${wait_seconds} seconds, until $(LC_TIME=C date --date="${wait_seconds} seconds")..."
      sleep $wait_seconds
    else
      break
    fi
  done
}

function ptbx_delete_old_runs() {
  (
  if [ -n "$ZSH_NAME" ]; then
    set -y
  fi
  local daysago_start=${1:-91}
  local before="$(date -I --date="${daysago_start} days ago")"
  local runs_json
  while true; do
    echo "Before ${before}"
    runs_json="$(_github_get "/actions/runs?created=<=${before}&per_page=100")" || { _ptbx_wait_gh_ratelimit 101; continue; }
    local urls="$(printf "%s" "$runs_json" | jq -r '.workflow_runs[] | .url' | xargs echo)"
    if [ -z "$urls" ]; then
      echo "Empty page. Finishing..."
      break
    fi
    echo "Deleting $(printf "%s" "$urls" | wc -w)/$(printf "%s" "$runs_json" | jq -r '.total_count') runs... "
    { 
      _github_client --fail-early -f -X DELETE --parallel-max 10 -Z $urls && { 
        before="$(printf "%s" "$runs_json" | jq -r '.workflow_runs[-1] | .created_at')" || { echo "No created_at found."; break; } 
      }
    } || _ptbx_wait_gh_ratelimit 101
  done
  )
}

function ptbx_video_extract_audio() {
  local input="$1"
  local target="${input%.*}_new.aac"
  echo "Extracting to ${target}"
  ffmpeg -i "$input" -acodec copy "${target}"
}

function ptbx_video_replace_audio() {
  local video="$1"
  local audio="$2"
  local video_new="${video%.*}_replaced_audio.${video##*.}"
  ffmpeg -i "$video" -i "$audio" -vcodec copy -acodec aac -map 0:0 -map 1:0 "${video_new}"
}

function ptbx_video_speedup() {
  local video="$1"
  local video_new="${video%.*}_speedup.${video##*.}"
  local speedup="${2:-"1.25"}"
  local speedup_inverted="$(echo "scale=3; 1/${speedup}" | bc | sed 's/^\./0./')"
  ffmpeg -i "$video" -filter_complex "[0:v]setpts=${speedup_inverted}*PTS[v];[0:a]atempo=${speedup}[a]" -map "[v]" -map "[a]" "${video_new}"
}
