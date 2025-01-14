# Vagrant Windows 11 box for testing Pulsar on Windows

## Prerequisites

- Linux host running on Intel/AMD CPU (not Apple Silicon)
- [Vagrant](https://www.vagrantup.com/)
- [VirtualBox](https://www.virtualbox.org/)

## First time usage

It's necessary to run `vagrant up` and `vagrant halt` once to install the Windows 11 box.

```shell
vagrant up
# shutdown the box
vagrant halt
```

## Usage

```shell
vagrant up
# login to the box, password is "vagrant"
vagrant ssh
# shutdown the box
vagrant halt
```

### Usage in Windows shell to build Pulsar

while in the `vagrant ssh` shell, you can build Pulsar with the following commands:

git, java and maven are installed as part of the provisioning script.

```shell
git clone https://github.com/apache/pulsar
cd pulsar
git fetch origin pull/<PR NUMBER>/merge
git checkout FETCH_HEAD
mvn clean install -DskipTests
```

Instead of compiling in Windows shell, you can copy files into the Vagrant box directory on the host machine. The files will be available in the `C:\Users\vagrant\synced` directory.
You can use the 7zip's `7z x file_name` command to extract files in the Windows shell. For `.tar.gz` files, you will need to run the command twice since the first time, it will uncompress the file to a `.tar` file.

```shell
cd C:\Users\vagrant\synced
# do whatever you want here
```

## Troubleshooting

To start the box with GUI, run the following command:

```shell
vbgui=true vagrant up
```
