// Funcionalidade de alternar o Menu Lateral
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    sidebar.classList.toggle('open');
    toggleBtn.classList.toggle('open');
}

// Dropdowns de Header
const searchInput = document.getElementById('searchInput');
const searchSuggestions = document.getElementById('searchSuggestions');
searchInput.addEventListener('focus', () => {
    searchSuggestions.classList.add('show');
});

const btnFiltros = document.getElementById('btnFiltros');
const filtrosDropdown = document.getElementById('filtrosDropdown');
btnFiltros.addEventListener('click', (event) => {
    event.stopPropagation();
    filtrosDropdown.classList.toggle('show');
    btnFiltros.classList.toggle('active');
});

document.addEventListener('click', (event) => {
    if (!searchInput.contains(event.target) && !searchSuggestions.contains(event.target)) {
        searchSuggestions.classList.remove('show');
    }
    if (!btnFiltros.contains(event.target) && !filtrosDropdown.contains(event.target)) {
        filtrosDropdown.classList.remove('show');
        btnFiltros.classList.remove('active');
    }
});

// Toggle Switch Functionality da Tela de Perfil
function toggleSwitch(element) {
    element.classList.toggle('on');
    
    // Se for o toggle de privar perfil, salva o estado e atualiza o cadeado
    if (element.id === 'togglePrivate') {
        const isPrivate = element.classList.contains('on');
        localStorage.setItem('isPrivateProfile', isPrivate);
        const padlock = document.getElementById('privatePadlockSettings');
        if (padlock) padlock.style.display = isPrivate ? 'inline-block' : 'none';
    }
}

// Inicializar estado do cadeado nas configurações
document.addEventListener('DOMContentLoaded', () => {
    const togglePrivate = document.getElementById('togglePrivate');
    const padlock = document.getElementById('privatePadlockSettings');
    const storedPrivate = localStorage.getItem('isPrivateProfile');
    
    // Por padrão o html já tem 'on', então se for nulo, considera true
    const isPrivate = storedPrivate === null ? true : (storedPrivate === 'true');
    
    if (togglePrivate) {
        if (isPrivate) togglePrivate.classList.add('on');
        else togglePrivate.classList.remove('on');
    }
    
    if (padlock) {
        padlock.style.display = isPrivate ? 'inline-block' : 'none';
    }
});

// --- Lógica do Modal de Senha ---
const btnChangePassword = document.getElementById('btnChangePassword');
const senhaModalOverlay = document.getElementById('senhaModalOverlay');
const modalStep1 = document.getElementById('modalStep1');
const modalStep2 = document.getElementById('modalStep2');
const modalStep3 = document.getElementById('modalStep3');
const currentPasswordInput = document.getElementById('currentPasswordInput');
const newPasswordInput = document.getElementById('newPasswordInput');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');

// Abrir modal ao clicar em Senha
if (btnChangePassword) {
    btnChangePassword.addEventListener('click', () => {
        // Reseta o estado
        modalStep1.style.display = 'block';
        modalStep2.style.display = 'none';
        modalStep3.style.display = 'none';
        currentPasswordInput.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        document.getElementById('step1Error').style.display = 'none';
        document.getElementById('step2Error').style.display = 'none';

        senhaModalOverlay.classList.add('show');
        setTimeout(() => currentPasswordInput.focus(), 100);
    });
}

// Fechar ao clicar fora do Modal
if (senhaModalOverlay) {
    senhaModalOverlay.addEventListener('click', (event) => {
        if (event.target === senhaModalOverlay) {
            senhaModalOverlay.classList.remove('show');
        }
    });
}

// Passo 1 -> Passo 2 (Pressionando Enter)
if (currentPasswordInput) {
    currentPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const err1 = document.getElementById('step1Error');
            if (currentPasswordInput.value.trim() !== '') {
                // Simulação: Transição pro passo 2
                err1.style.display = 'none';
                modalStep1.style.display = 'none';
                modalStep2.style.display = 'block';
                setTimeout(() => newPasswordInput.focus(), 100);
            } else {
                err1.innerText = 'Digite a senha atual.';
                err1.style.display = 'block';
            }
        }
    });
}

// Passo 2 (Nova senha vai pra Confirmação via Enter)
if (newPasswordInput) {
    newPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            confirmPasswordInput.focus();
        }
    });
}

// Passo 2 -> Passo 3 Sucesso (Pressionando Enter em confirmar)
if (confirmPasswordInput) {
    confirmPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const err2 = document.getElementById('step2Error');
            err2.style.display = 'none';

            if (newPasswordInput.value.trim() === '') {
                err2.innerText = 'A nova senha não pode ser vazia.';
                err2.style.display = 'block';
                return;
            }

            const password = newPasswordInput.value;
            const numberCount = (password.match(/\d/g) || []).length;
            const specialCount = (password.match(/[^A-Za-z0-9]/g) || []).length;

            if (password.length < 8 || numberCount < 3 || specialCount < 1) {
                err2.innerText = 'A senha precisa ter no mínimo 8 caracteres, 3 números e 1 caractere especial.';
                err2.style.display = 'block';
                return;
            }

            if (newPasswordInput.value === confirmPasswordInput.value) {
                // Sucesso!
                modalStep2.style.display = 'none';
                modalStep3.style.display = 'block';

                // Fecha apenas após 2.5 segundos para o usuário ver
                setTimeout(() => {
                    senhaModalOverlay.classList.remove('show');
                }, 2500);
            } else {
                err2.innerText = 'As senhas digitadas não coincidem. Verifique e tente novamente!';
                err2.style.display = 'block';
            }
        }
    });
}

// Toggle mostrar/ocultar senha
function togglePasswordVis(...ids) {
    ids.forEach(id => {
        const input = document.getElementById(id);
        if (input.type === 'password') {
            input.type = 'text';
        } else {
            input.type = 'password';
        }
    });
}

// --- Lógica do Modal de Sobre ---
const btnSobre = document.getElementById('btnSobre');
const sobreModalOverlay = document.getElementById('sobreModalOverlay');
const generoOptionsContainer = document.getElementById('generoOptionsContainer');

if (btnSobre) {
    btnSobre.addEventListener('click', () => {
        sobreModalOverlay.classList.add('show');
    });
}

if (sobreModalOverlay) {
    sobreModalOverlay.addEventListener('click', (event) => {
        if (event.target === sobreModalOverlay) {
            sobreModalOverlay.classList.remove('show');
        }
    });
}

// Simula seleção do gênero
if (generoOptionsContainer) {
    const generosBtns = generoOptionsContainer.querySelectorAll('.btn-genero');
    generosBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove destaque de todos
            generosBtns.forEach(b => b.classList.remove('selected'));
            // Adiciona apenas no botão clicado
            btn.classList.add('selected');
        });
    });
}

// --- Alteração das imagens do perfil ---
const photoModalOverlay = document.getElementById('photoModalOverlay');
const photoModalTitle = document.getElementById('photoModalTitle');
const photoModalDescription = document.getElementById('photoModalDescription');
const photoFileInput = document.getElementById('photoFileInput');
const photoUploadPrompt = document.getElementById('photoUploadPrompt');
const photoPreviewContainer = document.getElementById('photoPreviewContainer');
const photoPreview = document.getElementById('photoPreview');
const photoUploadError = document.getElementById('photoUploadError');
const savePhotoButton = document.getElementById('savePhotoButton');
const maxPhotoSize = 3 * 1024 * 1024;
let activePhotoType = null;
let selectedPhotoData = null;

function applyPhotoToEditor(type, imageData) {
    const element = type === 'profile'
        ? document.querySelector('.profile-picture')
        : document.querySelector('.banner');

    if (element && imageData) {
        element.style.backgroundImage = `url("${imageData}")`;
        element.style.backgroundPosition = 'center';
        element.style.backgroundRepeat = 'no-repeat';
        element.style.backgroundSize = 'cover';
    }
}

function showPhotoPreview(imageData) {
    photoPreview.classList.toggle('profile-preview', activePhotoType === 'profile');
    photoPreview.style.backgroundImage = `url("${imageData}")`;
    photoPreviewContainer.hidden = false;
}

function closePhotoModal() {
    photoModalOverlay.classList.remove('show');
    photoModalOverlay.setAttribute('aria-hidden', 'true');
    photoFileInput.value = '';
    selectedPhotoData = null;
    activePhotoType = null;
    savePhotoButton.disabled = true;
    photoUploadError.textContent = '';
}

function openPhotoModal(type) {
    activePhotoType = type;
    selectedPhotoData = null;
    photoFileInput.value = '';
    photoUploadError.textContent = '';
    savePhotoButton.disabled = true;
    photoPreviewContainer.hidden = true;

    const isProfilePhoto = type === 'profile';
    const imageKey = isProfilePhoto ? 'profilePhoto' : 'profileBanner';
    const storedImage = localStorage.getItem(imageKey);
    photoModalTitle.textContent = isProfilePhoto ? 'Alterar foto de perfil' : 'Alterar foto do banner';
    photoModalDescription.textContent = isProfilePhoto
        ? 'Escolha uma imagem para usar como foto de perfil.'
        : 'Escolha uma imagem para usar como banner do perfil.';
    photoUploadPrompt.textContent = storedImage
        ? 'Clique aqui para escolher outra imagem'
        : 'Clique aqui para escolher uma imagem';

    if (storedImage) {
        showPhotoPreview(storedImage);
    }

    photoModalOverlay.classList.add('show');
    photoModalOverlay.setAttribute('aria-hidden', 'false');
    document.getElementById('closePhotoModalButton').focus();
}

document.getElementById('changeProfilePhotoButton').addEventListener('click', () => {
    openPhotoModal('profile');
});

document.getElementById('changeBannerButton').addEventListener('click', () => {
    openPhotoModal('banner');
});

photoFileInput.addEventListener('change', () => {
    const file = photoFileInput.files[0];
    photoUploadError.textContent = '';
    savePhotoButton.disabled = true;
    selectedPhotoData = null;

    if (!file) return;

    if (!file.type.startsWith('image/')) {
        photoUploadError.textContent = 'Selecione um arquivo de imagem válido.';
        return;
    }

    if (file.size > maxPhotoSize) {
        photoUploadError.textContent = 'A imagem deve ter no máximo 3 MB.';
        return;
    }

    const reader = new FileReader();
    reader.addEventListener('load', () => {
        if (typeof reader.result !== 'string') {
            photoUploadError.textContent = 'Não foi possível carregar a imagem. Tente outro arquivo.';
            return;
        }

        selectedPhotoData = reader.result;
        showPhotoPreview(selectedPhotoData);
        savePhotoButton.disabled = false;
    });
    reader.addEventListener('error', () => {
        photoUploadError.textContent = 'Não foi possível ler o arquivo de imagem.';
    });
    reader.readAsDataURL(file);
});

savePhotoButton.addEventListener('click', () => {
    if (!activePhotoType || !selectedPhotoData) return;

    const imageKey = activePhotoType === 'profile' ? 'profilePhoto' : 'profileBanner';
    try {
        localStorage.setItem(imageKey, selectedPhotoData);
    } catch (error) {
        photoUploadError.textContent = 'Não foi possível salvar a imagem neste navegador. Tente um arquivo menor.';
        return;
    }

    applyPhotoToEditor(activePhotoType, selectedPhotoData);
    closePhotoModal();
});

document.getElementById('cancelPhotoButton').addEventListener('click', closePhotoModal);
document.getElementById('closePhotoModalButton').addEventListener('click', closePhotoModal);

photoModalOverlay.addEventListener('click', event => {
    if (event.target === photoModalOverlay) closePhotoModal();
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && photoModalOverlay.classList.contains('show')) {
        closePhotoModal();
    }
});

applyPhotoToEditor('profile', localStorage.getItem('profilePhoto'));
applyPhotoToEditor('banner', localStorage.getItem('profileBanner'));
