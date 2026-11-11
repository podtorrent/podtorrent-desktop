#!/bin/sh
# swift test, also with only the Command Line Tools (no Xcode): their Swift Testing isn't on the default paths.
D=/Library/Developer/CommandLineTools/Library/Developer
if [ "$(xcode-select -p)" = /Library/Developer/CommandLineTools ]; then
  exec swift test -Xswiftc -F$D/Frameworks -Xlinker -F$D/Frameworks -Xlinker -rpath -Xlinker $D/Frameworks \
    -Xlinker -rpath -Xlinker $D/usr/lib "$@"
fi
exec swift test "$@"
