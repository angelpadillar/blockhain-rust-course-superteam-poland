from pathlib import Path
import json, shutil, os

path = Path('/data/captions-editor-agent/config/editor.json')
backup = path.with_name('editor.before-auth-repair.json')
if not backup.exists():
    shutil.copy2(path, backup)
config = json.loads(path.read_text())
config['testAccountOnly'] = False
config['accountScope'] = 'owner-authorized'
# WorkOS and Mirage were observed in Captions' actual login flow. The provider
# hosts support the account owner's original Google or Apple sign-in method.
auth_hosts = ['api.workos.com', 'auth.mirage.app', 'accounts.google.com', 'appleid.apple.com']
config['onboardingDomains'] = sorted(set(config.get('onboardingDomains', []) + auth_hosts))
config['interactiveAuthDomains'] = auth_hosts
config['resourceDomains'] = sorted(set(config.get('resourceDomains', []) + [
    'as.captions.ai', 'internal.captions-api.com', 'workos.imgix.net',
    'www.gstatic.com', 'ssl.gstatic.com', 'fonts.googleapis.com',
    'fonts.gstatic.com', 'appleid.cdn-apple.com'
]))
routes = config.get('mutationRoutes', [])
routes = [r for r in routes if (r['host'], r['path']) != ('as.captions.ai', '/v1/initialize')]
routes.append({'host': 'as.captions.ai', 'path': '/v1/initialize',
               'methods': ['POST'], 'phase': 'read',
               'contentTypes': ['application/json', 'text/plain']})
config['mutationRoutes'] = routes
path.write_text(json.dumps(config, indent=2) + '\n')
os.chown(path, 1000, 1000)
os.chmod(path, 0o600)
print('Owner-authorized login configuration updated; autonomous edit routes unchanged.')
