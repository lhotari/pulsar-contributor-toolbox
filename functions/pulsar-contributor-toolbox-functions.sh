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
[[ $(echo $PATH | grep -c "${PULSAR_CONTRIBUTOR_TOOLBOX}/bin") -eq 0 ]] && \
    export PATH="$PULSAR_CONTRIBUTOR_TOOLBOX/bin:$PATH"

# useful aliases

# this is useful when cherry-picking/merging while avoiding previous merge conflict resolutions
alias git_norerere='git -c rerere.enabled=false'
alias mcss='mcs search -l 100'

# functions

# disabling rerere for the current git repository
# this is useful when cherry-picking/merging while avoiding previous merge conflict resolutions
function ptbx_git_rerere_disable() {
  echo "Disabling rerere for the current git repository. Current rerere.enabled setting: $(git config rerere.enabled)"
  git config rerere.enabled false
  echo "Current rerere.enabled setting: $(git config rerere.enabled)"
}

# unsetting rerere setting for the current git repository and relying on the global rerere setting
function ptbx_git_rerere_unset() {
  echo "Unsetting rerere for the current git repository. Current rerere.enabled setting: $(git config rerere.enabled)"
  git config unset rerere.enabled
  echo "Current rerere.enabled setting: $(git config rerere.enabled)"
}

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
    local clean_param="clean"
    if [[ "$1" == "--noclean" || "$1" == "-nc" ]]; then
      clean_param=""
      shift
    else
      ptbx_clean_snapshots
    fi
    local sources_param=""
    if [[ "$1" == "--sources" ]]; then
      sources_param="source:jar"
      shift
    fi
    mvn -Pcore-modules,-main -T 1C $clean_param $sources_param install -DskipTests -Dspotbugs.skip=true -DnarPluginPhase=none "$@"
  )
}

function ptbx_checkstyle() {
  (
    ptbx_cd_git_root
    mvn -T 1C initialize checkstyle:check "$@"
  )
}

function ptbx_checkstyle_and_license() {
  (
    ptbx_cd_git_root
    mvn -T 1C initialize checkstyle:check license:check "$@"
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
    command mvn -T 1C install -DskipTests -Dcheckstyle.skip=true -Dlicense.skip=true -Dspotbugs.skip=true -DintegrationTests -Dtest=NoneTest -DfailIfNoTests=false -am -pl tests/integration "$@"
  )
}

function ptbx_run_inttest() {
  (
    ptbx_cd_git_root
    export PULSAR_TEST_IMAGE_NAME=apachepulsar/java-test-image:latest
    command mvn test -DredirectTestOutputToFile=false -DtestRetryCount=0 -Dcheckstyle.skip=true -Dlicense.skip=true -Dspotbugs.skip=true -DintegrationTests -pl tests/integration "$@"
  )
}

function ptbx_run_systest() {
  (
    ptbx_cd_git_root
    export PULSAR_TEST_IMAGE_NAME=apachepulsar/pulsar-test-latest-version:latest
    command mvn -T 1C test -DredirectTestOutputToFile=false -DtestRetryCount=0 -Dspotbugs.skip=true -DintegrationTests -pl tests/integration "$@"
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
    local platform=""
    local no_host_net=0
    while [ true ]; do
      if [[ "$1" =~ --cpus=.* ]]; then
        cpus="${1#*=}"
        shift
      elif [[ "$1" =~ --memory=.* ]]; then
        memory="${1#*=}"
        shift
      elif [[ "$1" =~ --platform=.* ]]; then
        platform="$1"
        shift
      elif [[ "$1" == --no-host-net ]]; then
        no_host_net=1
        shift
      else
        break
      fi
    done
    local host_net_param="--net=host"
    if [[ $no_host_net == 1 ]]; then
      host_net_param=""
    fi
    if [[ -z "$platform" ]]; then
      if uname -m | grep -q x86_64; then
        platform="--platform=linux/amd64"
      else
        platform="--platform=linux/arm64"
      fi
    fi
    local arch="${platform#*=}"
    arch="${arch#*/}"
    local testcontainers_param=""
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
      additional_groups=()
      for gid in $(id -G); do
        additional_groups+=("--group-add=$gid")
      done
      docker run $platform --env-file=<(printenv) --security-opt seccomp=unconfined --cap-add SYS_ADMIN --cpus=$cpus --memory=$memory -u "$UID:${GID:-"$(id -g)"}" "${additional_groups[@]}" $host_net_param -it --rm -v $HOME:$HOME -v /var/run/docker.sock:/var/run/docker.sock -w $PWD -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro ubuntu "$@"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
      local imagename="ubuntu_sdkman_${arch}"
      local imageid=$(docker images -q $imagename 2> /dev/null)
      testcontainers_param="-e TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal"
      if [[ -n "$imageid" && -n "$platform" ]]; then
        if ! docker image inspect --format "{{.Os}}/{{.Architecture}}" $imageid | grep -i -q -- "${platform#*=}"; then
          imageid=""
        fi
      fi
      if [ ! -f $HOME/.bashrc_docker_${arch} ]; then
        echo "# bashrc for ptbx_docker_run for ${arch}" >> $HOME/.bashrc_docker_${arch}
      fi
      if [[ -z "$imageid" ]]; then
        docker build $platform --tag $imagename - <<EOT
FROM ubuntu:latest
ARG DEBIAN_FRONTEND=noninteractive
RUN <<'EOS' /bin/bash
set -eux
set -o pipefail
apt-get update
apt-get dist-upgrade -y
apt-get install -y curl zip unzip wget ca-certificates git tig locales netcat-openbsd jq docker.io vim procps less netcat-openbsd dnsutils iputils-ping
locale-gen en_US.UTF-8
groupadd -g $GID mygroup || true
useradd -M -d $HOME -u $UID -g $GID -s /bin/bash $USER
adduser $USER root
EOS
EOT
        docker run $platform -e HOME=$HOME -e SDKMAN_DIR=$HOME/.sdkman_docker_${arch} -e GRADLE_USER_HOME=$HOME/.gradle_docker $host_net_param -it --rm -v $HOME:$HOME -u "$UID:${GID:-"$(id -g)"}" -v /var/run/docker.sock:/var/run/docker.sock -v $HOME/.bashrc_docker_${arch}:$HOME/.bashrc -w $PWD $imagename bash -c 'curl -s "https://get.sdkman.io" | bash; source $SDKMAN_DIR/bin/sdkman-init.sh; echo "sdkman_auto_answer=true" >> $SDKMAN_DIR/etc/config; sdk install java 17.0.13-amzn; sdk install maven; sdk install gradle'
      fi
      docker run $platform --env-file=<(printenv |egrep -v 'SDKMAN|HOME|MANPATH|INFOPATH|PATH') -e HOME=$HOME -e TERM=xterm -e SDKMAN_DIR=$HOME/.sdkman_docker_${arch} -e GRADLE_USER_HOME=$HOME/.gradle_docker -e DOCKER_HOST=unix:///var/run/docker.sock $testcontainers_param --privileged --security-opt seccomp=unconfined --cap-add SYS_ADMIN --cpus=$cpus --memory=$memory $host_net_param -it --rm -u "$UID:${GID:-"$(id -g)"}" --group-add 0 -v $HOME:$HOME -v /var/run/docker.sock:/var/run/docker.sock -v $HOME/.bashrc_docker_${arch}:$HOME/.bashrc -w $PWD $imagename "$@"
    else
      echo "Unsupported OS: $OSTYPE"
      return 1
    fi
  )
}

function ptbx_docker_run_arm64() {
  ptbx_docker_run --platform=linux/arm64 "$@"
}

function ptbx_docker_run_amd64() {
  ptbx_docker_run --platform=linux/amd64 "$@"
}

# runs a command with sdkman initialized in the docker container
function ptbx_docker_run_with_sdkman {
  local docker_args=()
  while [ true ]; do
    case "$1" in
      --cpus=*)
        docker_args+=("$1")
        shift
        ;;
      --memory=*)
        docker_args+=("$1")
        shift
        ;;
      --platform=*)
        docker_args+=("$1")
        shift
        ;;
      *)
        break
        ;;
    esac
  done
  ptbx_docker_run "${docker_args[@]}" bash -i -c 'source $SDKMAN_DIR/bin/sdkman-init.sh; "$@"' bash "$@"
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
    ptbx_until_test_fails_in_docker "$@" |& ptbx_tee_log
  )
}

function ptbx_until_test_fails() {
  (
    bash -c "$(ptbx_until_test_fails_script)" bash "$@"
  )
}

function ptbx_until_test_fails_with_logs() {
  (
    ptbx_until_test_fails "$@" |& ptbx_tee_log
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
    mvn -DtestFailFast=false -DexcludedGroups='' --fail-at-end -DredirectTestOutputToFile=false -DtestRetryCount=0 test "$@"
  )
}

function ptbx_run_test_in_docker() {
  (
    local cpus=2
    local memory=6g
    local platform=""
    while [ true ]; do
      if [[ "$1" =~ --cpus=.* ]]; then
        cpus="${1#*=}"
        shift
      elif [[ "$1" =~ --memory=.* ]]; then
        memory="${1#*=}"
        shift
      elif [[ "$1" =~ --platform=.* ]]; then
        platform="$1"
        shift
      else
        break
      fi
    done
    ptbx_docker_run --cpus=$cpus --memory=$memory $platform \
      bash -c 'source $HOME/.sdkman/bin/sdkman-init.sh; mvn -DredirectTestOutputToFile=false -DtestRetryCount=0 test "$@"' bash "$@"
  )
}

function ptbx_run_test_and_detect_leaks() {
  (
    # create a temp directory
    local temp_dir=$(mktemp -d)
    local netty_leak_dump_dir=$temp_dir/netty-leak-dump
    local thread_leak_detector_dir=$temp_dir/thread-leak-detector
    mkdir -p $netty_leak_dump_dir
    mkdir -p $thread_leak_detector_dir
    local thread_leak_detector_wait_millis=10000

    # run the test
    NETTY_LEAK_DUMP_DIR=$netty_leak_dump_dir THREAD_LEAK_DETECTOR_WAIT_MILLIS=$thread_leak_detector_wait_millis THREAD_LEAK_DETECTOR_DIR=$thread_leak_detector_dir ptbx_run_test "$@"
    # check for leaks
    local leaks_detected=0
    local netty_leak_files=$(find $netty_leak_dump_dir -type f)
    if [ -n "$netty_leak_files" ]; then
      { echo "Leaks detected"; grep -h -i test $netty_leak_dump_dir/* | grep org.apache | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^Hint: //' | sort -u; echo Details:; cat $netty_leak_dump_dir/*; } | less
      leaks_detected=1
    fi
    local thread_leak_files=$(find $thread_leak_detector_dir -type f)
    if [ -n "$thread_leak_files" ]; then
      cat $thread_leak_detector_dir/threadleak*.txt | awk '/^Summary:/ {print $0 "\n"; next} {print}'
      leaks_detected=1
    fi
    if [ $leaks_detected -ne 0 ]; then
      echo "Leaks detected. Files in $temp_dir"
      return 1
    fi
    rm -rf $temp_dir
  )
}

function ptbx_run_changed_tests() {
  (
    local run_all=0
    if [[ "$1" == "--all" ]]; then
      run_all=1
      shift
    fi
    local compare_to_branch="${1:-"origin/$(ptbx_detect_default_branch)"}"
    ptbx_cd_git_root
    local root_dir=$(pwd)
    local last_module=""
    local -a test_classes=()
    while read -r file; do
      local module=$(echo "$file" | sed 's#/src/.*##g')      
      if [[ "$module" != "$last_module" && "$last_module" != "" && -n ${test_classes[*]} ]]; then
        cd "$root_dir/$last_module"
        test_classes=($(printf "%s\n" "${test_classes[@]}" | sort -u))
        printf "Running tests in %s for classes:\n" "$last_module"
        printf "\t%s\n" "${test_classes[@]}"
        ptbx_run_test -DtestRetryCount=1 -Dsurefire.failIfNoSpecifiedTests=false -Dtest="$(IFS=, ; echo "${test_classes[*]}")" || { echo "Failed to run tests in $last_module"; exit 1; }
        test_classes=()
      fi
      if [[ "$file" =~ src/test/java/.*Test\.java$ ]]; then
        local test_class=$(echo "$file" | sed 's#.*src/test/java/##;s#\.java$##;s#/#.#g')
        test_classes+=("$test_class")
      elif [[ $run_all == 1 && "$file" =~ src/main/java/.*\.java$ ]]; then
        local test_class="$(echo "$file" | sed 's#.*src/main/java/##;s#\.java$##;s#/#.#g')Test"
        test_classes+=("$test_class")
      fi
      last_module="$module"      
    done < <(git diff --name-only "${compare_to_branch}")
    # if test_classes isn't empty
    if [[ "$last_module" != "" && -n ${test_classes[*]} ]]; then
      cd "$root_dir/$last_module"
      test_classes=($(printf "%s\n" "${test_classes[@]}" | sort -u))
      printf "Running tests in %s for classes:\n" "$last_module"
      printf "\t%s\n" "${test_classes[@]}"
      ptbx_run_test -DtestRetryCount=1 -Dsurefire.failIfNoSpecifiedTests=false -Dtest="$(IFS=, ; echo "${test_classes[*]}")"  || { echo "Failed to run tests in $last_module"; exit 1; }
    fi
  )
}

function ptbx_print_changed_tests_run_commands() {
  (
    local compare_to_branch="${1:-"origin/$(ptbx_detect_default_branch)"}"
    ptbx_cd_git_root
    local root_dir=$(pwd)
    while read -r file; do
      local module=$(echo "$file" | sed 's#/src/.*##g')      
      if [[ "$file" =~ src/test/java/.*Tests?\.java$ ]]; then
        local test_class=$(echo "$file" | sed 's#.*src/test/java/##;s#\.java$##;s#/#.#g')
        test_classes+=("$test_class")
        echo "ptbx_run_test_and_detect_leaks -pl $module -Dtest=$test_class"
      fi
    done < <(git diff --name-only "${compare_to_branch}")
  )
}

function ptbx_build_changed_modules() {
  (
    local compare_to_branch="${1:-"origin/$(ptbx_detect_default_branch)"}"
    ptbx_cd_git_root
    changed_modules=$(git diff --name-only "${compare_to_branch}" | grep '/src/' | sed 's#/src/.*##g' | sort -u | tr '\n' ',' | sed 's/,$/\n/')
    if [[ -n "$changed_modules" ]]; then
      set -x
      mvn -pl "$changed_modules" install -DskipTests -Dspotbugs.skip=true
    else
      echo "No changed modules."
    fi
  )
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
  ptbx_gitpush_to_remote forked
}

function ptbx_gitpush_to_remote() {
  (
    remote="${1?remote name required}"
    CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    if [ -n "$CURRENTBRANCH" ]; then
      git push -f "$remote" "$CURRENTBRANCH:$CURRENTBRANCH"
    fi
  )
}

# pushes changes to a PR branch to the forked repository
# use this when you have a PR branch checked out with
# command "gh pr checkout <pr-number>" and want to push changes to it
function ptbx_gitpush_to_pr_branch() {
  (
    PR_NUMBER="$1"
    if [ -z "$PR_NUMBER" ]; then
      echo "Pass PR number as argument"
      return 1
    fi
    SLUG=$(ptbx_gh_slug origin)
    FORK_REPO=$(curl -s https://api.github.com/repos/$SLUG/pulls/$PR_NUMBER | jq -r '.head.repo.html_url')
    FORK_BRANCH=$(curl -s https://api.github.com/repos/$SLUG/pulls/$PR_NUMBER | jq -r '.head.ref')
    if [ -z "$FORK_REPO" ]; then
      echo "Cannot find forked repo for PR $PR_NUMBER"
      return 1
    fi
    git push "$FORK_REPO" "HEAD:$FORK_BRANCH"
  )
}

# synchronizes the forked/master remote branch with origin/master
function ptbx_git_sync_forked_master_with_upstream() {
  (
    git fetch origin
    local default_branch=$(ptbx_detect_default_branch)
    git update-ref refs/heads/${default_branch} origin/${default_branch}
    git push -f forked ${default_branch}
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
      git push -f forked "refs/remotes/origin/${branch}:refs/heads/${branch}"
    done
  )
}

function ptbx_git_sync_pulsar_maintenance_branches_with_upstream() {
  (
    cd ~/workspace-pulsar/pulsar
    _ptbx_git_sync_branches origin branch-3.0 branch-3.3 branch-4.0
  )
}

function ptbx_maven_do_release_version_commits() {
  (
    mvn -ntp -B versions:set -DremoveSnapshot -DgenerateBackupPoms=false
    RELEASE_VERSION=$(command mvn -ntp -B help:evaluate -Dexpression=project.version -q -DforceStdout)
    git commit -m "Release v$RELEASE_VERSION" -a
    git tag v$RELEASE_VERSION
    mvn -ntp -B versions:set -DnextSnapshot -DgenerateBackupPoms=false
    SNAPSHOT_VERSION=$(command mvn -ntp -B help:evaluate -Dexpression=project.version -q -DforceStdout)
    git commit -m "Next development version v$SNAPSHOT_VERSION" -a
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
  if command -v xmlstarlet &>/dev/null; then
    # fast way to extract project version
    xmlstarlet sel -t -m _:project -v _:version -n pom.xml
  else
    # prints out the project version and nothing else
    # https://maven.apache.org/plugins/maven-help-plugin/evaluate-mojo.html#forceStdout
    mvn initialize help:evaluate -Dexpression=project.version -pl . -q -DforceStdout | sed 's/\[INFO\] \[stdout\] //' | grep -F -v '[WARN]' | tail -1
  fi
}

function ptbx_build_docker_pulsar_all_image() {
  (
    docker pull alpine:3.21
    command mvn clean install -DskipTests -Dspotbugs.skip=true -Dlicense.skip=true -Dcheckstyle.skip=true
    command mvn install -pl docker/pulsar,docker/pulsar-all \
        -DskipTests -Dspotbugs.skip=true -Dlicense.skip=true -Dcheckstyle.skip=true \
        -Pmain,docker \
        -Ddocker.noCache=true \
        -Ddocker.skip.tag=false
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

function ptbx_build_java_test_image() {
  (
    docker pull alpine:3.21
    ptbx_cd_git_root
    ./build/build_java_test_image.sh "$@" || return 1
  )
}

function ptbx_build_and_push_java_test_image_to_microk8s() {
  (
    ptbx_build_and_push_java_test_image localhost:32000/apachepulsar
  )
}

function ptbx_build_and_push_java_test_image() {
  (
    ptbx_build_java_test_image
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
  local default_branch=$(ptbx_detect_default_branch)
  gh pr create "--repo=$(ptbx_forked_repo)" --base "${default_branch}" --head "$(git branch --show-current)" -f "$@"
}

function ptbx_detect_default_branch() {
  if [[ "$(git branch --list -r origin/main | wc -l)" == "1" ]]; then
    echo main
  else
    echo master
  fi
}


function ptbx_github_open_pr() {
  local github_user="$(ptbx_forked_repo)"
  github_user="${github_user%/*}"
  local default_branch=$(ptbx_detect_default_branch)
  gh pr create "--repo=$(ptbx_gh_slug origin)" --base "${default_branch}" --head "$github_user:$(git branch --show-current)" -w
}

function ptbx_github_test_pr_in_own_fork() {
  local github_user="$(ptbx_forked_repo)"
  github_user="${github_user%/*}"
  local pr_json=$(curl -s "https://api.github.com/repos/$(ptbx_gh_slug origin)/pulls?head=${github_user}:$(git branch --show-current)" |jq '.[0]')
  if printf "%s" "${pr_json}" | jq --arg github_user "${github_user}" -e 'select(.user.login == $github_user)' &> /dev/null; then
    local fork_pr_title=$(printf "%s" "${pr_json}" | jq -r '"[run-tests] " + .title')
    local pr_url=$(printf "%s" "${pr_json}" | jq -r '.html_url')
    local fork_pr_body="This PR is for running tests for upstream PR ${pr_url}."
    ptbx_git_sync_forked_master_with_upstream
    ptbx_github_open_pr_to_own_fork -b "${fork_pr_body}" -t "${fork_pr_title}"
    local fork_pr_json=$(curl -s "https://api.github.com/repos/$(ptbx_forked_repo)/pulls?head=$(git branch --show-current)" |jq '.[0]')
    local fork_pr_url=$(printf "%s" "${fork_pr_json}" | jq -r '.html_url')
    if [ -n "${fork_pr_url}" ]; then
      local pr_body_updated=$(printf "%s" "${pr_json}" | jq --arg fork_pr_url "${fork_pr_url}" -r '.body | sub("(?s)<!-- ENTER URL HERE.*?-->";$fork_pr_url)')
      if [ -n "${pr_body_updated}" ]; then
        gh pr edit "${pr_url}" --body "${pr_body_updated}"
      fi
    fi
  else
    echo "Cannot find PR for current branch."
  fi
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
  local default_branch=$(ptbx_detect_default_branch)
  git rev-parse --abbrev-ref "${default_branch}@{upstream}"
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

function ptbx_extract_threaddumps_from_file() {
  local prefix="threaddump${RANDOM}_$(date -I)_"
  cat "$1" | awk '{sub(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+Z /, "")} /^Full thread dump OpenJDK/{p=1; dump_count++} /^----------------------- pid/{if(p){print "DUMPSEPARATOR";p=0;if(dump_count>1)next}} /^[[:space:]]*class space/{print;if(dump_count>1)exit} p' | csplit - -f $prefix -b %02d.txt -z --suppress-matched '/DUMPSEPARATOR/' '{*}'
  for file in ${prefix}*; do
    if ! grep -q "Full thread dump OpenJDK" $file; then
      rm $file
    fi
  done
}

function ptbx_find_created_threads_in_test_logs() {
  grep -shEr "created [0-9]+ new threads" * | awk -F "Summary: " '{ print $2 }' | awk '{ print $(NF-2), $0}' |sort -rn | cut -f2- -d' '
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
  PR_NUM=${1:-1}

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

function ptbx_split_splunk_threaddumps() {
  local jsonfile="$1"
  jq  '.result._raw | fromjson | {"message": .message | join("\n")} | select(.message | contains("Full thread dump"))' "$jsonfile" |jq -s . |mlr --ijson --opprint --ho put -q 'begin { @ts=systimeint(); }; emit >"/tmp/threaddump".@ts."_".NR.".txt", $message;'
}

function ptbx_mvn_list_modules() {
  (
    mvn -B -ntp -Dscan=false "$@" initialize \
      | grep -- "-< .* >-" \
      | sed -E 's/.*-< (.*) >-.*/\1/'
  )
}

function ptbx_join_lines() {
  tr '\n' ',' | sed 's/,$/\n/'
}

function ptbx_docker_socket_proxy() {
  local port=2375
  socat /dev/null TCP4:127.0.0.1:$port,connect-timeout=2 &> /dev/null
  if [ $? -ne 0 ]; then
    echo "Starting socat tcp proxy on port $port for docker socket /var/run/docker.sock"
    socat TCP-LISTEN:$port,bind=127.0.0.1,reuseaddr,fork UNIX-CLIENT:/var/run/docker.sock &> /dev/null &
    echo "Stop the proxy with 'kill $!'"
  fi
  export DOCKER_HOST=tcp://127.0.0.1:$port
  echo "Added DOCKER_HOST=$DOCKER_HOST to environment"
}

function ptbx_bk_build() {
  (
    ptbx_cd_git_root
    local clean_param="clean"
    if [[ "$1" == "--noclean" || "$1" == "-nc" ]]; then
      clean_param=""
      shift
    else
      ptbx_bk_clean_snapshots
    fi
    mvn -T 1C $clean_param install -DskipTests -Dspotbugs.skip=true -Ddistributedlog "$@"
  )
}

function ptbx_bk_docker_build() {
  (
    ptbx_bk_build -Pdocker "$@" 
  )
}

function ptbx_bk_clean_snapshots() {
  (
    if [ -n "$ZSH_NAME" ]; then
      setopt nonomatch
    fi
    ls -d ~/.m2/repository/org/apache/{bookkeeper,distributedlog}/**/"$(ptbx_project_version)" 2>/dev/null | xargs -r rm -rf
  )
}

function ptbx_bk_checks() {
  (
    ptbx_cd_git_root
    mvn -T 1C apache-rat:check checkstyle:check spotbugs:check package -Ddistributedlog -DskipTests
  )
}

function ptbx_bk_license_check() {
  (
    ptbx_cd_git_root
    dev/check-all-licenses
  )
}

function _ptbx_urlencode() {
    python3 -c "import urllib.parse, sys; print(urllib.parse.quote_plus(sys.argv[1]))" "$1"
}

function ptbx_cherry_pick_check() {
  (
    local UPSTREAM=origin
    local PROJECT_VERSION=$(ptbx_project_version)
    local RELEASE_NUMBER=$(echo "$PROJECT_VERSION" | sed 's/-SNAPSHOT//')
    local CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    local RELEASE_BRANCH=$CURRENTBRANCH
    local PR_QUERY="is:merged label:release/$RELEASE_NUMBER"
    if [[ "$PROJECT_VERSION" == "$RELEASE_NUMBER" ]]; then
      # use pipx to run semver to get the next release number
      local NEXT_RELEASE_NUMBER=$(pipx run semver bump patch $PROJECT_VERSION 2>/dev/null)
      PR_QUERY="$PR_QUERY,release/$NEXT_RELEASE_NUMBER"
    fi
    PR_QUERY="$PR_QUERY -label:cherry-picked/$RELEASE_BRANCH NOT $RELEASE_BRANCH in:title"
    local PR_NUMBERS=$(gh pr list -L 100 --search "$PR_QUERY" --json number --jq '["#"+(.[].number|tostring)] | join("|")')
    local SLUG=$(ptbx_gh_slug origin)
    if [[ -z "$PR_NUMBERS" ]]; then
      echo "No PRs found for query: '$PR_QUERY'"
    else
      local GIT_LOG_OUTPUT=$(git log --oneline -P --grep="$PR_NUMBERS" --reverse $RELEASE_BRANCH)
      local ALREADY_PICKED=$(echo "$GIT_LOG_OUTPUT" \
        | grep -v 'Revert "' \
        | gawk 'match($0, /.*(\(#([0-9]+)\))/, a) {print substr(a[1], 2, length(a[1])-2)}' \
        | tr '\n' '|' | sed 's/|$//')
      local REVERTED_PR_NUMBERS=$(echo "$GIT_LOG_OUTPUT" \
        | grep 'Revert "' \
        | gawk 'match($0, /.*(\(#([0-9]+)\))/, a) {print substr(a[1], 2, length(a[1])-2)}' \
        | tr '\n' '|' | sed 's/|$//')
      # Remove reverted PR numbers from ALREADY_PICKED
      if [[ -n "$ALREADY_PICKED" && -n "$REVERTED_PR_NUMBERS" ]]; then
        # Remove any PR number in REVERTED_PR_NUMBERS from ALREADY_PICKED
        local FILTERED_ALREADY_PICKED=$(echo "$ALREADY_PICKED" | tr '|' '\n' | grep -vxFf <(echo "$REVERTED_PR_NUMBERS" | tr '|' '\n') | tr '\n' '|' | sed 's/|$//')
        ALREADY_PICKED="$FILTERED_ALREADY_PICKED"
      fi
      if [[ -n "$ALREADY_PICKED" ]]; then
        echo -e "\033[31m** Already picked but not tagged as cherry-picked **\033[0m"
        git log --color --oneline -P --grep="$ALREADY_PICKED" --reverse $RELEASE_BRANCH | gawk 'match($0, /.*(\(#([0-9]+)\))/, a) {print $0 " https://github.com/'$SLUG'/pull/" substr(a[1], 3, length(a[1])-3)}' | awk '{ print $0 " https://github.com/'$SLUG'/commit/" $1 }'
        echo "ptbx_cherry_pick_add_picked $(printf "$ALREADY_PICKED" | sed 's/|/ /g' | sed 's/#//g')" | tee >(pbcopy)
      fi
      echo -e "\033[31m** Not cherry-picked from $UPSTREAM/master **\033[0m"
      git log --color --oneline -P --grep="$PR_NUMBERS" --reverse $UPSTREAM/master | { [ -n "$ALREADY_PICKED" ] && grep -v -E "$ALREADY_PICKED" || cat; } | { [ -n "$REVERTED_PR_NUMBERS" ] && grep -v -E "$REVERTED_PR_NUMBERS" || cat; } | gawk 'match($0, /\(#([0-9]+)\)/, a) {print $0 " https://github.com/'$SLUG'/pull/" substr(a[0], 3, length(a[0])-3)}'
      git log --oneline -P --grep="$PR_NUMBERS" --reverse $UPSTREAM/master | { [ -n "$ALREADY_PICKED" ] && grep -v -E "$ALREADY_PICKED" || cat; } | { [ -n "$REVERTED_PR_NUMBERS" ] && grep -v -E "$REVERTED_PR_NUMBERS" || cat; } | gawk '{ print "git cpx " $1 }' | { [ -z "$ALREADY_PICKED" ] && tee >(pbcopy) || cat; }
    fi
    echo -e "\033[34m** Urls **\033[0m"
    echo "PRs that haven't been cherry-picked: https://github.com/$SLUG/pulls?q=$(_ptbx_urlencode "is:pr $PR_QUERY")"
  )
}

function ptbx_cherry_pick_move_to_release() {
  (
    local NEXT_RELEASE=$1
    local RELEASE_NUMBER=${2:-$(ptbx_project_version | sed 's/-SNAPSHOT//')}
    if [[ -z "$NEXT_RELEASE" ]]; then
      echo "Usage: ptbx_cherry_pick_move_to_release <next_release> (<from_release>)"
      return 1
    fi
    echo "Moving PRs from release/$RELEASE_NUMBER to release/$NEXT_RELEASE"
    local SLUG=$(ptbx_gh_slug origin)
    local UPSTREAM=origin
    local CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    local RELEASE_BRANCH=$CURRENTBRANCH
    local PR_QUERY="label:release/$RELEASE_NUMBER -label:cherry-picked/$RELEASE_BRANCH NOT $RELEASE_BRANCH in:title"
    local PR_NUMBERS=$(gh pr list -L 100 --search "$PR_QUERY" --state all --json number,state --jq '[.[] | select(.state == "MERGED" or .state == "OPEN") | .number | tostring] | join(" ")')
    if [[ -z "$PR_NUMBERS" ]]; then
      echo "No PRs found for query: '$PR_QUERY'"
      return 1
    fi
    for PR_NUMBER in $PR_NUMBERS; do
      echo "Editing PR: $PR_NUMBER"
      gh pr edit "$PR_NUMBER" --add-label "release/$NEXT_RELEASE" --remove-label "release/$RELEASE_NUMBER" --repo "$SLUG"
    done
  )
}

function ptbx_cherry_pick_add_to_release() {
  (
    local ADD_TO_RELEASE=$1
    local TARGET_BRANCH_MILESTONE=$2
    local RELEASE_NUMBER=${3:-$(ptbx_project_version | sed 's/-SNAPSHOT//')}
    if [[ -z "$ADD_TO_RELEASE" || -z "$TARGET_BRANCH_MILESTONE" ]]; then
      echo "Usage: ptbx_cherry_pick_add_to_release <add_to_release> <target_branch_milestone> <from_release>"
      return 1
    fi
    echo "Adding PRs with release/$RELEASE_NUMBER to release/$ADD_TO_RELEASE"
    local SLUG=$(ptbx_gh_slug origin)
    local UPSTREAM=origin
    local CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    local RELEASE_BRANCH=$CURRENTBRANCH
    local PR_QUERY="label:release/$RELEASE_NUMBER label:cherry-picked/$RELEASE_BRANCH -label:release/$ADD_TO_RELEASE -milestone:$TARGET_BRANCH_MILESTONE -label:cherry-picked/$ADD_TO_RELEASE NOT $RELEASE_BRANCH in:title"
    local PR_NUMBERS=$(gh pr list -L 100 --search "$PR_QUERY" --state all --json number,state --jq '[.[] | select(.state == "MERGED" or .state == "OPEN") | .number | tostring] | join(" ")')
    if [[ -z "$PR_NUMBERS" ]]; then
      echo "No PRs found for query: '$PR_QUERY'"
      return 1
    fi
    for PR_NUMBER in $PR_NUMBERS; do
      echo "Editing PR: $PR_NUMBER"
      gh pr edit "$PR_NUMBER" --add-label "release/$ADD_TO_RELEASE" --repo "$SLUG"
    done
  )
}

function ptbx_parse_gitlog_prnums() {
  (
    # use with command like "git log --oneline v4.0.2-candidate-2..v4.0.2-candidate-3"
    gawk 'match($0, /.*\(#([0-9]+)\)/, a) {print a[1]}' | tr '\n' ' ' | sed 's/ $//'
  )
}

function ptbx_gh_move_to_milestone() {
  (
    local FROM_MILESTONE=$1
    local NEXT_MILESTONE=$2
    local BACKPORT_RELEASE=$3
    if [[ -z "$FROM_MILESTONE" || -z "$NEXT_MILESTONE" || -z "$BACKPORT_RELEASE" ]]; then
      echo "Usage: ptbx_gh_move_to_milestone <from_milestone> <next_milestone> [<backport_release>]"
      return 1
    fi
    echo "Moving PRs from milestone $FROM_MILESTONE to milestone $NEXT_MILESTONE"
    local SLUG=$(ptbx_gh_slug origin)
    local PR_QUERY="milestone:$FROM_MILESTONE"
    local PR_NUMBERS=$(gh pr list -L 100 --search "$PR_QUERY" --state open --json number --jq '[.[].number | tostring] | join(" ")')
    if [[ -z "$PR_NUMBERS" ]]; then
      echo "No PRs found for query: '$PR_QUERY'"
      return 1
    fi
    for PR_NUMBER in $PR_NUMBERS; do
      echo "Editing PR: $PR_NUMBER"
      gh pr edit "$PR_NUMBER" --milestone "$NEXT_MILESTONE" --repo "$SLUG"
      if [[ -n "$BACKPORT_RELEASE" ]]; then
        local PR_DATA=$(gh pr view "$PR_NUMBER" --json labels,reviewDecision --jq '.')
        local HAS_READY_TO_TEST=$(echo "$PR_DATA" | jq '.labels[] | select(.name == "ready-to-test") | length > 0')
        local IS_APPROVED=$(echo "$PR_DATA" | jq '.reviewDecision == "APPROVED"')
        if [[ "$HAS_READY_TO_TEST" == "true" || "$IS_APPROVED" == "true" ]]; then
          gh pr edit "$PR_NUMBER" --add-label "release/$BACKPORT_RELEASE" --repo "$SLUG"
        fi
      fi
    done
  )
}

function ptbx_gh_remove_release_labels_from_stale_prs() {
  (
    local SLUG=$(ptbx_gh_slug origin)
    local PR_QUERY="label:Stale"
    local PR_NUMBERS=$(gh pr list -L 100 --repo "$SLUG" --search "$PR_QUERY" --state open --json number,labels --jq '[.[] | {number: .number | tostring, labels: [.labels[].name | select(startswith("release/"))]} | select(.labels | length > 0)] | map(.number) | join(" ")')
    if [[ -z "$PR_NUMBERS" ]]; then
      echo "No stale PRs found with Stale label and release labels"
      return 0
    fi
    for PR_NUMBER in $PR_NUMBERS; do
      echo "Processing PR #$PR_NUMBER"
      # Get all release labels for this PR
      local RELEASE_LABELS=$(gh pr view "$PR_NUMBER" --repo "$SLUG" --json labels --jq '.labels[].name | select(startswith("release/"))')
      # Remove each release label
      for LABEL in $RELEASE_LABELS; do
        echo "Removing label $LABEL from PR #$PR_NUMBER"
        gh pr edit "$PR_NUMBER" --remove-label "$LABEL" --repo "$SLUG"
      done
      # Remove milestone if present
      echo "Removing milestone from PR #$PR_NUMBER"
      gh pr edit "$PR_NUMBER" --remove-milestone --repo "$SLUG"
    done
  )
}




function ptbx_gh_first_commit_in_release() {
  (
    local FORK_POINT_BRANCH=${1:?Pass the fork point branch}
    local RELEASE_BRANCH=${2:?Pass the release branch}
    local merge_base=$(git merge-base $FORK_POINT_BRANCH $RELEASE_BRANCH)
    local first_commit_in_release=$(git rev-list --ancestry-path --first-parent $merge_base..$RELEASE_BRANCH | tail -n 1)
    echo $first_commit_in_release
  )
}

function ptbx_gh_update_milestone_in_merged_prs() {
  (
    local MILESTONE=${1:?Pass the milestone to move PRs to}
    local LAST_FORKED_BRANCH=${2:?Pass the last forked branch}
    local RELEASE_BRANCH=${3:?Pass the release branch}
    local MASTER_BRANCH=${4:-"master"}
    local first_commit_in_release=$(ptbx_gh_first_commit_in_release $LAST_FORKED_BRANCH $RELEASE_BRANCH)
    local timestamp_of_first_commit_in_release=$(git show -s --format=%cI $first_commit_in_release)
    local first_commit_in_release_branch=$(ptbx_gh_first_commit_in_release $MASTER_BRANCH $RELEASE_BRANCH)
    local timestamp_of_last_commit_in_release=$(git show -s --format=%cI $first_commit_in_release_branch)
    local SLUG=$(ptbx_gh_slug origin)
    local PR_QUERY="is:pr is:merged base:$MASTER_BRANCH -milestone:$MILESTONE merged:$timestamp_of_first_commit_in_release..$timestamp_of_last_commit_in_release"
    while true; do
      local PR_NUMBERS=$(gh pr list -L 100 --search "$PR_QUERY" --state all --json number --jq '[.[].number | tostring] | join(" ")')
      if [[ -z "$PR_NUMBERS" ]]; then
        echo "No PRs found for query: '$PR_QUERY'"
        break
      fi
      for PR_NUMBER in $PR_NUMBERS; do
        gh pr edit "$PR_NUMBER" --milestone "$MILESTONE" --repo "$SLUG"
      done
    done
    # remove invalid milestone definition in PRs where base is not master
    PR_QUERY="is:pr is:merged -base:$MASTER_BRANCH milestone:$MILESTONE"
    PR_NUMBERS=$(gh pr list -L 500 --search "$PR_QUERY" --state all --json number --jq '[.[].number | tostring] | join(" ")')
    if [[ -z "$PR_NUMBERS" ]]; then
      echo "No PRs found for query: '$PR_QUERY'"
      return 1
    fi
    for PR_NUMBER in $PR_NUMBERS; do
      echo "Removing milestone. Editing PR: $PR_NUMBER"
      gh pr edit "$PR_NUMBER" --remove-milestone --repo "$SLUG"
    done
  )
}

function ptbx_cherry_pick_add_picked() {
  (
    local PR_NUMBERS="$@"    
    local CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    local RELEASE_BRANCH=$CURRENTBRANCH
    local SLUG=$(ptbx_gh_slug origin)
    for PR_NUMBER in $PR_NUMBERS; do
      echo "Editing PR: $PR_NUMBER, adding cherry-picked/$RELEASE_BRANCH label"
      gh pr edit "$PR_NUMBER" --add-label "cherry-picked/$RELEASE_BRANCH"  --repo "$SLUG"
    done
  )
}

function ptbx_cherry_pick_add_release_labels() {
  (
    local PREV_RELEASE_NUMBER=${1:?Pass the previous release number as the first argument}
    local RELEASE_NUMBER=$(ptbx_project_version | sed 's/-SNAPSHOT//')
    local CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    local RELEASE_BRANCH=$CURRENTBRANCH
    local PR_QUERY="label:release/$RELEASE_NUMBER"
    local SLUG=$(ptbx_gh_slug origin)
    local RELEASE_TAG_PREFIX="v"
    if [[ "$SLUG" == "apache/bookkeeper" ]]; then
      RELEASE_TAG_PREFIX="release-"
    fi
    local PR_NUMBERS=$(gh pr list -L 100 --repo "$SLUG" --state merged --search "$PR_QUERY" --json number --jq '["#" + (.[].number|tostring)] | join("|")')
    local GREP_RULE=""
    if [[ -n "$PR_NUMBERS" ]]; then
      GREP_RULE="-P --invert-grep --grep=$PR_NUMBERS"
    fi
    local ALREADY_PICKED_NOT_IN_RELEASE=$(git log --oneline $GREP_RULE --reverse "${RELEASE_TAG_PREFIX}${PREV_RELEASE_NUMBER}..HEAD" | gawk 'match($0, /.*(\(#([0-9]+)\))/, a) {print substr(a[1], 3, length(a[1])-3)}')
    if [[ -z "$ALREADY_PICKED_NOT_IN_RELEASE" ]]; then
      echo "All PRs are already labeled with release/$RELEASE_NUMBER"
      return 1
    fi
    for PR_NUMBER in $ALREADY_PICKED_NOT_IN_RELEASE; do
      echo "Editing PR: $PR_NUMBER, adding release/$RELEASE_NUMBER and cherry-picked/$RELEASE_BRANCH labels, removing possible release/$PREV_RELEASE_NUMBER label"
      gh pr edit "$PR_NUMBER" --add-label "release/$RELEASE_NUMBER" --remove-label "release/$PREV_RELEASE_NUMBER" --add-label "cherry-picked/$RELEASE_BRANCH" --repo "$SLUG"
    done
 )
}

function ptbx_gh_add_label() {
  (
    local label_name=${1:?label_name is required}
    local label_color=${2:-"$(printf "%06x\n" $(shuf -i 1-16777215 -n 1))"}
    local SLUG=$(ptbx_gh_slug origin)
    GITHUB_TOKEN=$(gh auth token) gh api -X POST /repos/$SLUG/labels -f name="$label_name" -f color="$label_color" | jq .
  )
}

function ptbx_gha_ci_trigger() {
  (
    local remote=${1:-origin}
    local SLUG=$(ptbx_gh_slug $remote)
    local BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    if [[ "$SLUG" =~ .*/pulsar$ ]]; then
      case "$BRANCH" in
        branch-3.0|branch-3.2|branch-3.3|branch-4.0|branch-4.1|master)
          gh workflow run pulsar-ci.yaml -R $SLUG -r $BRANCH --field collect_coverage=false
          gh workflow run pulsar-ci-flaky.yaml -R $SLUG -r $BRANCH --field collect_coverage=false
          ;;
        *)
          echo "Unsupported branch $BRANCH"
          return 1
          ;;
      esac
    else 
      echo "Unsupported repository $SLUG"
      return 1
    fi
  )
}

function ptbx_gha_ci_list() {
  (
    local remote=${1:-origin}
    local SLUG=$(ptbx_gh_slug $remote)
    local BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    if [[ "$SLUG" =~ .*/pulsar$ ]]; then
      gh run list -R $SLUG -b $BRANCH --limit 5 --json status,conclusion,headBranch,startedAt,url,workflowName | jq -r '.[] | "\(.status) \(.conclusion) \(.headBranch) \(.startedAt) \(.url) \(.workflowName)"'
    else 
      echo "Unsupported repository $SLUG"
      return 1
    fi
  )
}

function ptbx_json_pp() {
  prettier --parser json --print-width 100 --tab-width 2 | bat --language json -p "$@"
}

function ptbx_bat_log() {
  # Use bat if it's available and no_bat is not set to 1 or true
  if [[ "$no_bat" != "1" && "$no_bat" != "true" ]] && command -v bat &> /dev/null; then
    bat -l log -pp "$@"
  else
    cat "$@"
  fi
}

function ptbx_tee_log() {
  local file_prefix="${1:-output}"
  local file_suffix=""
  if [[ $# -eq 1 ]]; then
    file_suffix="_$(ptbx_datetime)"
  elif [[ $# -eq 2 && -n "$2" ]]; then
    file_suffix="_$2"
  else
    file_suffix=""
  fi
  tee "${file_prefix}${file_suffix}.log" | ptbx_bat_log
}

function ptbx_run_standalone_g1gc_perf() {
  (
    export no_bat=${no_bat:-"true"}
    ptbx_run_standalone \
    --disable-leak-detection \
      PULSAR_MEM="-Xms2g -Xmx4g -XX:MaxDirectMemorySize=6g" \
      PULSAR_GC="-XX:+UseG1GC -XX:+PerfDisableSharedMem -XX:+AlwaysPreTouch" \
      "$@"
  )
}

function ptbx_get_pulsar_extra_opts() {
  local disable_leak_detection=""
  local -a extra_opts=(
    "-Dpulsar.allocator.exit_on_oom=true"
    "-Dio.netty.recycler.maxCapacityPerThread=4096"
  )

  while [[ $# -gt 0 ]]; do
    case $1 in
      --disable-leak-detection)
        disable_leak_detection="true"
        shift
        ;;
      *)
        extra_opts+=("$1")
        shift
        ;;
    esac
  done

  if [[ "$disable_leak_detection" != "true" ]]; then
    extra_opts+=(
      "-Dpulsar.allocator.leak_detection=Advanced"
      "-Dio.netty.leakDetectionLevel=advanced"
      "-Dio.netty.leakDetection.targetRecords=40"
    )
  fi

  echo "${extra_opts[@]}"
}

function ptbx_run_standalone() {
  ptbx_cd_pulsar_dir
  local -a filtered_env_vars=()
  local -a extra_opts_args=()

  # Process arguments
  while [[ $# -gt 0 ]]; do
    case $1 in
      *=*)
        if [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*=.* ]]; then
          filtered_env_vars+=("$1")
        fi
        shift
        ;;
      --disable-leak-detection)
        extra_opts_args+=("$1")
        shift
        ;;
      *)
        extra_opts_args+=("$1")
        shift
        ;;
    esac
  done

  # Archive data directory if it exists
  if [ -d "data" ]; then
    echo "Archiving existing data directory..."
    mkdir -p data.archives
    mv data "data.archives/data.$(ptbx_datetime)"
  fi

  local extra_opts=$(ptbx_get_pulsar_extra_opts "${extra_opts_args[@]}")
  env PULSAR_STANDALONE_USE_ZOOKEEPER=1 PULSAR_EXTRA_OPTS="$extra_opts" "${filtered_env_vars[@]}" bin/pulsar standalone -nss -nfw 2>&1 | ptbx_tee_log standalone
}

function ptbx_run_pulsar_docker() {
  local pulsar_image_name="apachepulsar/pulsar"
  local -a filtered_env_vars=()
  local datetime=$(ptbx_datetime)
  local -a extra_opts_args=()

  # Process arguments
  while [[ $# -gt 0 ]]; do
    case $1 in
      *=*)
        if [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*=.* ]]; then
          filtered_env_vars+=("-e" "$1")
        fi
        shift
        ;;
      *"/"*)
        pulsar_image_name="$1"
        shift
        ;;
      --disable-leak-detection)
        extra_opts_args+=("$1")
        shift
        ;;
      *)
        extra_opts_args+=("$1")
        shift
        ;;
    esac
  done

  local extra_opts=$(ptbx_get_pulsar_extra_opts "${extra_opts_args[@]}")

  docker run --rm -it --name pulsar-standalone-$datetime \
    -e PULSAR_STANDALONE_USE_ZOOKEEPER=1 \
    -e PULSAR_EXTRA_OPTS="$extra_opts" \
    -p 8080:8080 -p 6650:6650 \
    "${filtered_env_vars[@]}" \
    $pulsar_image_name \
    sh -c "bin/apply-config-from-env.py conf/standalone.conf && bin/pulsar standalone -nss -nfw" \
    | ptbx_tee_log docker_standalone $datetime
}

function ptbx_async_profiler_opts() {
  local event="cpu"
  local profile_name="profile"
  local datetime=$(ptbx_datetime)
  local silent=false

  while [[ $# -gt 0 ]]; do
    case $1 in
      --exceptions)
        event="Java_java_lang_Throwable_fillInStackTrace"
        shift
        ;;
      -n|--name)
        profile_name="$2"
        shift 2
        ;;
      -s|--silent)
        silent=true
        shift
        ;;
      *)
        shift
        ;;
    esac
  done
  
  local jfr_file_name_prefix="${profile_name}_$datetime"
  local jfr_dir="$(pwd)/flamegraphs/${jfr_file_name_prefix}"

  mkdir -p "$jfr_dir"
  
  local -a opts=(
    "start"
    "event=$event"
    "alloc=2m"
    "lock=10ms"
    "jfrsync=$profile_name"
    "cstack=vmx"
    "file=$jfr_dir/${jfr_file_name_prefix}.jfr"
  )

  local os_type=$(uname -s | tr '[:upper:]' '[:lower:]')
  local lib_suffix=".so"
  if [[ "$os_type" == "darwin" ]]; then
    lib_suffix=".dylib"
  fi

  local async_profiler_lib="$HOME/tools/async-profiler/lib/libasyncProfiler$lib_suffix"

  if [[ ! -f "$async_profiler_lib" ]]; then
    echo "Error: async-profiler library not found at $async_profiler_lib"
    echo "Please install async-profiler with ptbx_async_profiler_install_nightly"
    return 1
  fi

  export OPTS="-XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints -agentpath:$async_profiler_lib=$(IFS=,; echo "${opts[*]}")"
  if [ "$silent" = false ]; then
    echo -e "Setting\nexport OPTS=\"$OPTS\"" | ptbx_bat_log
  fi
}

function ptbx_jfr_flamegraphs() {
  local jfr_file="$1"
  local jfr_base_name="${jfr_file##*/}"
  jfr_base_name="${jfr_base_name%.*}"
  local jfr_dir="$(dirname "$jfr_file")"
  local async_profiler_dir="$HOME/tools/async-profiler"
  local jfrconv="$async_profiler_dir/bin/jfrconv"

  if [ ! -f "$jfr_file" ]; then
    echo "Input JFR file not found: $jfr_file"
    return 1
  fi

  if [ ! -x "$jfrconv" ]; then
    echo "jfrconv not found or not executable: $jfrconv"
    echo "Please install async-profiler nightly build with ptbx_async_profiler_install_nightly"
    return 1
  fi

  local profile_types=("cpu" "wall" "alloc" "lock")
  
  for type in "${profile_types[@]}"; do
    local output_base="${jfr_dir}/${jfr_base_name}_${type}"
    
    # Generate flamegraph without --threads
    "$jfrconv" "--${type}" --title "${jfr_base_name} ${type}" "$jfr_file" "${output_base}.html"
    
    # Generate flamegraph with --threads
    "$jfrconv" "--${type}" --threads --title "${jfr_base_name} ${type} (threads)" "$jfr_file" "${output_base}_threads.html"

    # Generate flamegraph with --classify
    "$jfrconv" "--${type}" --classify --title "${jfr_base_name} ${type} (classify)" "$jfr_file" "${output_base}_classify.html"
  done

  local jfr_dir_path=$(readlink -f "${jfr_dir}")
  echo "Flamegraphs generated in ${jfr_dir_path}:"
  if [[ "$TERM_PROGRAM" == "iTerm.app" ]]; then
    find "${jfr_dir_path}" -name "*.html"
  else
    find "${jfr_dir_path}" -name "*.html" -printf "file://%p\n"
  fi
}

function ptbx_microbench_build_all() {
  (
    ptbx_cd_git_root
    mvn -Pcore-modules,microbench,-main -T 1C clean package
  )
}

function ptbx_microbench_build() {
  (
    ptbx_cd_git_root
    mvn -Pcore-modules,microbench,-main -pl microbench package
  )
}

function ptbx_microbench_run() {
  (
    if [[ -z "$1" ]]; then
      echo "Benchmark name is required"
      return 1
    fi
    ptbx_cd_git_root
    java -jar microbench/target/microbenchmarks.jar -rf json -rff jmh-result-$(date +%s).json "$@" | tee jmh-result-$(date +%s).txt
  )
}

function ptbx_microbench_list() {
  (
    ptbx_cd_git_root
    java -jar microbench/target/microbenchmarks.jar -l
  )
}

function ptbx_microbench_profile() {
  (
    if [[ -z "$1" ]]; then
      echo "Benchmark name is required"
      return 1
    fi
    if [[ -z "$LIBASYNCPROFILER_PATH" ]]; then
      echo "LIBASYNCPROFILER_PATH is not set"
      return 1
    fi
    if [[ ! -f "$LIBASYNCPROFILER_PATH" ]]; then
      echo "LIBASYNCPROFILER_PATH is not an executable file: $LIBASYNCPROFILER_PATH"
      return 1
    fi
    ptbx_cd_git_root
    java -jar microbench/target/microbenchmarks.jar -rf json -rff jmh-result-$(date +%s).json -prof async:libPath=$LIBASYNCPROFILER_PATH\;output=jfr\;dir=profile-results\;rawCommand=all,cstack=vmx "$@" | tee jmh-result-$(date +%s).txt
  )
}

function ptbx_async_profiler_install_nightly() {
  (
    set -e
    local os_type=$(uname -s | tr '[:upper:]' '[:lower:]')
    local arch=$(uname -m)
    local release_info=$(curl -s https://api.github.com/repos/async-profiler/async-profiler/releases/tags/nightly)
    local download_url

    if [[ "$os_type" == "linux" ]]; then
      if [[ "$arch" == "x86_64" ]]; then
        download_url=$(echo "$release_info" | jq -r '.assets[] | select(.name | contains("linux-x64.tar.gz")) | .browser_download_url')
      elif [[ "$arch" == "aarch64" ]]; then
        download_url=$(echo "$release_info" | jq -r '.assets[] | select(.name | contains("linux-arm64.tar.gz")) | .browser_download_url')
      else
        echo "Unsupported architecture: $arch"
        return 1
      fi
    elif [[ "$os_type" == "darwin" ]]; then
      download_url=$(echo "$release_info" | jq -r '.assets[] | select(.name | contains("macos.zip")) | .browser_download_url')
    else
      echo "Unsupported operating system: $os_type"
      return 1
    fi

    if [[ -z "$download_url" ]]; then
      echo "Could not find a suitable download URL for your system."
      return 1
    fi

    local temp_dir=$(mktemp -d)
    local archive_file="$temp_dir/async-profiler.archive"

    echo "Downloading async-profiler from $download_url"
    curl -L "$download_url" -o "$archive_file"

    local tools_dir="$HOME/tools"
    mkdir -p "$tools_dir"

    if [[ "$download_url" == *.zip ]]; then
      unzip -q "$archive_file" -d "$temp_dir"
    else
      tar -xzf "$archive_file" -C "$temp_dir"
    fi

    local extracted_dir=$(find "$temp_dir" -maxdepth 1 -type d -name "async-profiler*" -print -quit)
    if [[ -z "$extracted_dir" ]]; then
      echo "Could not find extracted async-profiler directory."
      return 1
    fi

    local version=$(basename "$extracted_dir")
    local target_dir="$tools_dir/$version"

    if [[ -d "$target_dir" ]]; then
      echo "Removing existing directory: $target_dir"
      rm -rf "$target_dir"
    fi

    mv "$extracted_dir" "$target_dir"

    local symlink="$tools_dir/async-profiler"
    if [[ -L "$symlink" ]]; then
      rm "$symlink"
    fi
    ln -s "$target_dir" "$symlink"

    echo "Async-profiler nightly build installed to $target_dir"
    echo "Symlink created: $symlink"

    # Clean up
    rm -rf "$temp_dir"
  )
}

function ptbx_docs_apply_patch_to_versioned_docs() {
  (
    local patchfile="${1:?Patch file is required}"
    shift
    local -a version_dirs
    if [ "$#" -eq 0 ]; then
        version_dirs=("version-3.0.x" "version-3.3.x" "version-4.0.x")
    else
        version_dirs=("$@")
    fi
    ptbx_cd_git_root
    cd versioned_docs
    for version_dir in "${version_dirs[@]}"; do
      cd "$version_dir"
      echo "Applying patch to $version_dir"
      patch -f -N -V none -p2 < "$patchfile" || echo "Failed to apply patch to $version_dir"
      cd ..
    done
  )
}

function ptbx_docs_apply_last_commit_to_versioned_docs() {
  (
    ptbx_cd_git_root
    local patchfile=$(mktemp)
    git format-patch --stdout -1 HEAD > "$patchfile"
    ptbx_docs_apply_patch_to_versioned_docs "$patchfile" "$@"
  )
}

function ptbx_docs_apply_git_diff_origin_main_to_versioned_docs() {
  (
    local doc_dir="docs"
    if [[ "$1" == "--doc-dir"  ]]; then
      shift
      doc_dir="$1"
      shift
    fi
    ptbx_cd_git_root
    local patchfile=$(mktemp)
    git diff -u $(git merge-base HEAD origin/main) -- "$doc_dir" > "$patchfile"
    ptbx_docs_apply_patch_to_versioned_docs "$patchfile" "$@"
  )
}

function ptbx_docs_merge_origin_using_docs_diff() {
  (
    local doc_dir="docs"
    if [[ "$1" == "--doc-dir"  ]]; then
      shift
      doc_dir="$1"
      shift
    fi
    ptbx_cd_git_root
    local patchfile=$(mktemp)
    git diff -u $(git merge-base HEAD origin/main) -- "$doc_dir" > "$patchfile"
    git merge -X theirs --no-edit origin/main
    cat "$patchfile" | patch -p1 || { echo "Failed to apply patch '$patchfile'."; return 1; }
    git add -u
    git commit --amend --no-edit
    ptbx_docs_apply_patch_to_versioned_docs "$patchfile" "$@"
  )
}

function ptbx_delete_patch_backups() {
  (
    find '(' -name "*.rej" -or -name "*.orig" ')' -delete
  )
}

# Function to query all common DNS record types for a domain
function ptbx_dns_all() {
  (
    local domain=$1
    local dns_server=$2

    # If DNS server is provided, use it
    local server_option=""
    if [ -n "$dns_server" ]; then
        server_option="@$dns_server"
    fi

    echo "==== DNS Records for $domain ===="
    if [ -n "$dns_server" ]; then
        echo "==== Using DNS server: $dns_server ===="
    fi
    echo ""

    # Common DNS record types
    local record_types=("A" "AAAA" "CNAME" "MX" "NS" "SOA" "TXT" "SRV" "CAA" "DNSKEY" "DS" "NAPTR" "PTR" "SSHFP")

    # Try ANY query first (though many servers block it)
    echo "Attempting ANY query (may be blocked by DNS servers):"
    result=$(dig $server_option $domain ANY +noall +answer | grep -v "^;" | grep -v "^$")
    if [ -n "$result" ]; then
        echo "$result"
    else
        echo "No results for ANY query (likely blocked by DNS server)"
    fi
    echo ""

    # Query each record type individually
    for type in "${record_types[@]}"; do
        # Store the result in a variable to check if it's empty
        # Use grep to filter out comment lines (starting with ;) and empty lines
        result=$(dig $server_option $domain $type +noall +answer | grep -v "^;" | grep -v "^$")
        
        # Only display the section if there are results
        if [ -n "$result" ]; then
            echo "==== $type records ===="
            echo "$result"
            echo ""
        fi
    done
  )
}

function ptbx_mvn_quickstart() {
  (
    if [[ "$1" == "--help" ]]; then
      echo "usage example: ptbx_mvn_quickstart -DgroupId=com.example -DartifactId=my-app -DinteractiveMode=false"
      return 0
    fi
    mvn archetype:generate -DarchetypeArtifactId=maven-archetype-quickstart -DarchetypeVersion=1.5 "$@"
  )
}

function ptbx_docker_allow_perfevents() {
  # configures docker container to allow perfevents
  # so that async-profiler can be run inside the container
  docker run --rm -it --privileged --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
    alpine sh -c "echo 1 > /proc/sys/kernel/perf_event_paranoid \
    && echo 0 > /proc/sys/kernel/kptr_restrict \
    && echo 1024 > /proc/sys/kernel/perf_event_max_stack \
    && echo 2048 > /proc/sys/kernel/perf_event_mlock_kb"
}

# prepares environment for inttest profiling 
function ptbx_prepare_env_for_inttest_profiling() {
  export PULSAR_TEST_IMAGE_NAME=apachepulsar/java-test-image:latest
  export NETTY_LEAK_DETECTION=off
  export ENABLE_MANUAL_TEST=true
}

# opens a root shell in the the docker host machine
function ptbx_docker_root_shell() {
  docker run --rm -it --privileged --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
    --pid host ubuntu bash -c "nsenter -t 1 --all /bin/sh"
}

function ptbx_build_java_test_image_with_async_profiler() {
  ptbx_build_java_test_image -Ddocker.install.asyncprofiler=true "$@"
}