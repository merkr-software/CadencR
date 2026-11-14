#!/bin/bash

# Cadencr: an upgrade also runs the old package's after-remove. RPM runs it
# after the new package's after-install, with $1 the number of versions left
# (1 or more), so it would remove the link the new one just registered; DEB
# passes "upgrade". The new package keeps the link and the AppArmor profile.
case "$1" in
    [1-9]* | upgrade | failed-upgrade) exit 0 ;;
esac

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
# Cadencr: electron-builder's default after-remove (app-builder-lib
# templates/linux/after-remove.tpl), for the link to the command line that
# build/linux/after-install.tpl registers.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/resources/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi