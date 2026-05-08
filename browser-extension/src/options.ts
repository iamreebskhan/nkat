import { loadOptions, saveOptions } from './lib/storage';

async function bootstrap() {
  const opts = await loadOptions();
  const $url = document.getElementById('backend-url') as HTMLInputElement;
  const $org = document.getElementById('org-id') as HTMLInputElement;
  const $user = document.getElementById('user-id') as HTMLInputElement;
  const $state = document.getElementById('default-state') as HTMLInputElement;
  const $save = document.getElementById('save') as HTMLButtonElement;
  const $status = document.getElementById('status') as HTMLParagraphElement;

  $url.value = opts.backendUrl;
  $org.value = opts.orgId;
  $user.value = opts.userId ?? '';
  $state.value = opts.defaultState ?? '';

  $save.addEventListener('click', async () => {
    await saveOptions({
      backendUrl: $url.value.trim() || 'http://localhost:3000',
      orgId: $org.value.trim(),
      ...($user.value.trim() ? { userId: $user.value.trim() } : {}),
      ...($state.value.trim() ? { defaultState: $state.value.trim().toUpperCase() } : {}),
    });
    $status.textContent = 'Saved.';
    setTimeout(() => { $status.textContent = ''; }, 2000);
  });
}

void bootstrap();
