#!/bin/bash -x

export RELEASE=${RELEASE:-$(git describe --tags | sed s/v//g | sed s/-/+/g)}

message=$(git show -s --format=%B HEAD)

if [ "$1" == "build" ]
then
    dch -v $RELEASE \
        --package node-iotronic-lightning-rod "$message - g$(git rev-parse --short HEAD)" \
        --distribution $(lsb_release -c | awk {'print $2'}) -M
    debuild --no-lintian -b -us -uc
elif [ "$1" == "clean" ]
then
    fakeroot debian/rules clean
    git checkout .
else
    echo "nothing"
fi