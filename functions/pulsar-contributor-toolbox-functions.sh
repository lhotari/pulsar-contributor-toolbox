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
    mvn -ntp -T 1C -Dassembly.skipAssembly=true -DskipSourceReleaseAssembly=true -DskipBuildDistribution=true -Dspotbugs.skip=true verify -DskipTests "$@"
  )
}

function ptbx_build_coremodules() {
  (
    ptbx_cd_git_root
    ptbx_clean_snapshots
    mvn -Pcore-modules -T 1C clean install -DskipTests -Dspotbugs.skip=true -Dassembly.skipAssembly=true
  )
}

function ptbx_clean_snapshots() {
  (
    if [ -n "$ZSH_NAME" ]; then
      setopt nonomatch
    fi
    ls -d ~/.m2/repository/org/apache/pulsar/**/*-SNAPSHOT 2> /dev/null | xargs -r rm -rf
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
    docker run --cpus=$cpus --memory=$memory -u $UID:$GID --net=host -it --rm -v $HOME:$HOME -w $PWD -v /etc/passwd:/etc/passwd:ro ubuntu "$@"
  )
}

# runs a command with sdkman initialized in the docker container
function ptbx_docker_run_with_sdkman {
   ptbx_docker_run bash -c 'source $HOME/.sdkman/bin/sdkman-init.sh; "$@"' bash "$@"
}


# runs tests with docker to limit cpu & memory, in a loop until it fails
# it is assumed that sdkman is used for JDK management. the default JDK version will be used within docker.
# example: ptbx_until_test_fails_in_docker -Pcore-modules -pl pulsar-broker -Dtest=TopicReaderTest
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
  cat << 'EOF'
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
    local UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)
    UPSTREAM="${UPSTREAM:-origin/master}"
    CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    ORIGINNAME=$(dirname $UPSTREAM)
    ORIGINURL=$(git config --get remote.$ORIGINNAME.url)
    REPONAME=$(basename $GITDIR)
    parentdir=$(dirname $GITDIR)
    CLONEDIR="$parentdir/$REPONAME.testclone"
    cd $parentdir
    [ -d "$REPONAME.testclone" ] && echo "Clone already exists" && exit 1
    git clone -b $CURRENTBRANCH $GITDIR/.git $REPONAME.testclone
    cd $REPONAME.testclone
    git remote rename origin local
    git remote add $ORIGINNAME "$ORIGINURL"
    git fetch local
    git fetch $ORIGINNAME
    git branch --set-upstream-to $UPSTREAM
    git config receive.denyCurrentBranch ignore
    git config gc.auto 0
    echo "Clone created in $(pwd)"
    cd "$GITDIR"
    git remote add testclone "$CLONEDIR/.git"
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

# updates the testclone
function ptbx_local_clone_update() {
  (
    [[ "$1" == "1" ]] || ptbx_local_clone_cd
    local UPSTREAM="$2"
    git fetch local
    local update_needed=0
    git rev-parse --verify -q $CURRENTBRANCH >/dev/null || update_needed=1
    git diff --quiet $CURRENTBRANCH local/$CURRENTBRANCH || update_needed=1
    if [ $update_needed -eq 1 ]; then
      git checkout -B $CURRENTBRANCH local/$CURRENTBRANCH
      [ -z "$UPSTREAM" ] || git branch --set-upstream-to $UPSTREAM
      exit 0
    else
      echo "No changes."
      exit 1
    fi
  )
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
  ) > ~/.ssh/multipass_ssh_config
  echo 'Updated ~/.ssh/sshconfig_multipass. use "Include ~/.ssh/multipass_ssh_config" to include it in ~/.ssh/config'
}

# creates a multipass vm and installs docker in it
function ptbx_multipass_create_vm_with_docker() {
  local vmname="$1"
  [ -n "$vmname" ] || { echo "Pass VM name as argument"; return 1; }
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
    ssh-keygen -y -f ~/.ssh/multipass_id_rsa > ~/.ssh/multipass_id_rsa.pub
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
    cat "$filename" | ansi2txt > "${filename}.txt"
    gh gist create "${filename}.txt" "$@"   
  )
}

function ptbx_project_version() {
  # prints out the project version and nothing else
  # https://maven.apache.org/plugins/maven-help-plugin/evaluate-mojo.html#forceStdout
  mvn initialize help:evaluate -Dexpression=project.version -pl . -q -DforceStdout
}

function ptbx_build_docker_pulsar_all_image() {
  (
  ptbx_clean_cppbuild
  mvn clean install -DskipTests
  mvn package -Pdocker -am -pl docker/pulsar-all
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
  docker_repo_prefix=${1:-lhotari}
  gitrev=$(git rev-parse HEAD | colrm 10)
  project_version=$(ptbx_project_version)
  docker_tag="${project_version}-$gitrev"
  set -xe  
  docker tag apachepulsar/pulsar-all:latest ${docker_repo_prefix}/pulsar-all:${docker_tag}
  docker tag apachepulsar/pulsar:latest ${docker_repo_prefix}/pulsar:${docker_tag}
  docker push ${docker_repo_prefix}/pulsar-all:${docker_tag}
  docker push ${docker_repo_prefix}/pulsar:${docker_tag}
  )
}