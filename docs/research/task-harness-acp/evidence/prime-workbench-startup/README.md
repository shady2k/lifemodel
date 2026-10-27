# Prime workbench startup trace (amd64)

This is the captured output and exact driver from the workbench built from the review-fix worktree based on `3cafcf7c`. The build output records image manifest
`sha256:f1ab2505d56cb24db8f146507060f28b42ba3c87609737e8c43026f682e11f90`.
The image tag was `w6539-4`. Run (driver supplied on stdin):

```sh
lifemodel-heavy docker run --rm --name w6539-4-offline --network none --read-only \
  --tmpfs /work:uid=1000,gid=1000,mode=0700 --entrypoint node -i w6539-4 < driver.cjs
```

The driver starts `strace -f -e trace=connect` on the actual Prime process,
creates an ACP session using the baked templates and offline environment, and
rejects any AF_INET or AF_INET6 connect. The recorded command exited 0;
`initialize` and `session/new` succeeded. The captured trace contains only
Unix socket connects. It does not cover prompts, other architectures,
connectionless `sendto`, or changes made after this build. Network isolation
alone would not reveal unsuccessful connection attempts.

The isolated test image does not currently provision strace; its normal test
boundary also does not change Docker's tracing security policy. This trace is
retained instead of claiming that the command traps or denied network prove
no attempted connections. Rebuild and repeat after changes to startup inputs.
