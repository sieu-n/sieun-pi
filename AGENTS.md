# sieun-pi

This repository owns the custom Prime Agent setup. Runtime credentials, account stores, logs, session history and learned memories stay outside Git.

Use the root build, check and apply commands. Do not change the live setup from a worker. Only the coordinating session applies it after isolated-profile verification.

Workers own disjoint directories. Do not change another worker's files. Do not commit or push until the coordinator has reviewed the source and secret scan.

Target Prime Agent first. Do not claim upstream Pi compatibility without a separate real runtime check.

Use the repository environment for Python and TypeScript checks. Keep source provenance and third-party notices. Do not publish this repository publicly or to npm without approval.
