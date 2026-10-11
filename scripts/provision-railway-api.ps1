#Requires -Version 5.1
<# Legacy provisioning rotated database credentials and recreated environments.
   It must not be used against the preserved production database. #>
throw 'Legacy Railway API provisioning is retired. It must not recreate dev/stg/preview or overwrite the current production database credentials. See documents/runbooks/production-release.md.'
