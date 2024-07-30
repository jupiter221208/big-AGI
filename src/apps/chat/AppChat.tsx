import * as React from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import type { SxProps } from '@mui/joy/styles/types';
import { useTheme } from '@mui/joy';

import { DEV_MODE_SETTINGS } from '../settings-modal/UxLabsSettings';
import { DiagramConfig, DiagramsModal } from '~/modules/aifn/digrams/DiagramsModal';
import { FlattenerModal } from '~/modules/aifn/flatten/FlattenerModal';
import { TradeConfig, TradeModal } from '~/modules/trade/TradeModal';
import { downloadConversation, openAndLoadConversations } from '~/modules/trade/trade.client';
import { getChatLLMId, useChatLLM } from '~/modules/llms/store-llms';
import { imaginePromptFromText } from '~/modules/aifn/imagine/imaginePromptFromText';
import { speakText } from '~/modules/elevenlabs/elevenlabs.client';
import { useAreBeamsOpen } from '~/modules/beam/store-beam.hooks';
import { useCapabilityTextToImage } from '~/modules/t2i/t2i.client';

import type { DConversation, DConversationId } from '~/common/stores/chat/chat.conversation';
import { ConfirmationModal } from '~/common/components/ConfirmationModal';
import { ConversationsManager } from '~/common/chats/ConversationsManager';
import { DMessageAttachmentFragment, DMessageContentFragment, duplicateDMessageFragments } from '~/common/stores/chat/chat.fragments';
import { OptimaPortalIn } from '~/common/layout/optima/portals/OptimaPortalIn';
import { PanelResizeInset } from '~/common/components/panes/GoodPanelResizeHandler';
import { PreferencesTab, useOptimaLayout, usePluggableOptimaLayout } from '~/common/layout/optima/useOptimaLayout';
import { ScrollToBottom } from '~/common/scroll-to-bottom/ScrollToBottom';
import { ScrollToBottomButton } from '~/common/scroll-to-bottom/ScrollToBottomButton';
import { addSnackbar } from '~/common/components/useSnackbarsStore';
import { createDMessageFromFragments, createDMessageTextContent, DMessageMetadata, duplicateDMessageMetadata } from '~/common/stores/chat/chat.message';
import { getConversation, getConversationSystemPurposeId, useConversation } from '~/common/stores/chat/store-chats';
import { themeBgAppChatComposer } from '~/common/app.theme';
import { useFolderStore } from '~/common/state/store-folders';
import { useGlobalShortcuts } from '~/common/components/shortcuts/useGlobalShortcuts';
import { useIsMobile } from '~/common/components/useMatchMedia';
import { useRouterQuery } from '~/common/app.routes';
import { useUXLabsStore } from '~/common/state/store-ux-labs';

import { ChatBarAltBeam } from './components/layout-bar/ChatBarAltBeam';
import { ChatBarAltTitle } from './components/layout-bar/ChatBarAltTitle';
import { ChatBarDropdowns } from './components/layout-bar/ChatBarDropdowns';
import { ChatBeamWrapper } from './components/ChatBeamWrapper';
import { ChatDrawerMemo } from './components/layout-drawer/ChatDrawer';
import { ChatMessageList } from './components/ChatMessageList';
import { ChatPageMenuItems } from './components/layout-menu/ChatPageMenuItems';
import { Composer } from './components/composer/Composer';
import { usePanesManager } from './components/panes/usePanesManager';

import type { ChatExecuteMode } from './execute-mode/execute-mode.types';

import { _handleExecute } from './editors/_handleExecute';
import { gcChatImageAssets } from './editors/image-generate';


// what to say when a chat is new and has no title
export const CHAT_NOVEL_TITLE = 'Chat';


export interface AppChatIntent {
  initialConversationId: string | null;
}


const composerOpenSx: SxProps = {
  zIndex: 21, // just to allocate a surface, and potentially have a shadow
  backgroundColor: themeBgAppChatComposer,
  borderTop: `1px solid`,
  borderTopColor: 'rgba(var(--joy-palette-neutral-mainChannel, 99 107 116) / 0.4)',
  // hack: eats the bottom of the last message (as it has a 1px divider)
  mt: '-1px',
};

const composerClosedSx: SxProps = {
  display: 'none',
};


export function AppChat() {

  // state
  const [isComposerMulticast, setIsComposerMulticast] = React.useState(false);
  const [isMessageSelectionMode, setIsMessageSelectionMode] = React.useState(false);
  const [diagramConfig, setDiagramConfig] = React.useState<DiagramConfig | null>(null);
  const [tradeConfig, setTradeConfig] = React.useState<TradeConfig | null>(null);
  const [clearConversationId, setClearConversationId] = React.useState<DConversationId | null>(null);
  const [deleteConversationIds, setDeleteConversationIds] = React.useState<DConversationId[] | null>(null);
  const [flattenConversationId, setFlattenConversationId] = React.useState<DConversationId | null>(null);
  const showNextTitleChange = React.useRef(false);
  const composerTextAreaRef = React.useRef<HTMLTextAreaElement>(null);
  const [_activeFolderId, setActiveFolderId] = React.useState<string | null>(null);

  // external state
  const theme = useTheme();

  const isMobile = useIsMobile();

  const intent = useRouterQuery<Partial<AppChatIntent>>();

  const showAltTitleBar = useUXLabsStore(state => DEV_MODE_SETTINGS && state.labsChatBarAlt === 'title');

  const { openLlmOptions, openModelsSetup, openPreferencesTab } = useOptimaLayout();

  const { chatLLM } = useChatLLM();

  const {
    // state
    chatPanes,
    focusedPaneIndex,
    focusedPaneConversationId,
    // actions
    navigateHistoryInFocusedPane,
    openConversationInFocusedPane,
    openConversationInSplitPane,
    removePane,
    setFocusedPaneIndex,
  } = usePanesManager();

  const { paneUniqueConversationIds, paneHandlers, paneBeamStores } = React.useMemo(() => {
    const paneConversationIds: (DConversationId | null)[] = chatPanes.map(pane => pane.conversationId || null);
    const paneHandlers = paneConversationIds.map(cId => cId ? ConversationsManager.getHandler(cId) : null);
    const paneBeamStores = paneHandlers.map(handler => handler?.getBeamStore() ?? null);
    const paneUniqueConversationIds = Array.from(new Set(paneConversationIds.filter(Boolean))) as DConversationId[];
    return {
      paneHandlers: paneHandlers,
      paneBeamStores: paneBeamStores,
      paneUniqueConversationIds: paneUniqueConversationIds,
    };
  }, [chatPanes]);

  const beamsOpens = useAreBeamsOpen(paneBeamStores);
  const beamOpenStoreInFocusedPane = React.useMemo(() => {
    const open = focusedPaneIndex !== null ? (beamsOpens?.[focusedPaneIndex] ?? false) : false;
    return open ? paneBeamStores?.[focusedPaneIndex!] ?? null : null;
  }, [beamsOpens, focusedPaneIndex, paneBeamStores]);

  const {
    // focused
    title: focusedChatTitle,
    isEmpty: isFocusedChatEmpty,
    isDeveloper: isFocusedChatDeveloper,
    conversationIdx: focusedChatNumber,
    // all
    hasConversations,
    recycleNewConversationId,
    // actions
    prependNewConversation,
    branchConversation,
    deleteConversations,
  } = useConversation(focusedPaneConversationId);

  const { mayWork: capabilityHasT2I } = useCapabilityTextToImage();

  const { activeFolderId } = useFolderStore(({ enableFolders, folders }) => {
    const activeFolderId = enableFolders ? _activeFolderId : null;
    const activeFolder = activeFolderId ? folders.find(folder => folder.id === activeFolderId) : null;
    return {
      activeFolderId: activeFolder?.id ?? null,
    };
  });


  // Window actions

  const isMultiPane = chatPanes.length >= 2;
  const isMultiAddable = chatPanes.length < 4;
  const isMultiConversationId = paneUniqueConversationIds.length >= 2;
  const willMulticast = isComposerMulticast && isMultiConversationId;
  const disableNewButton = isFocusedChatEmpty && !isMultiPane;

  const handleOpenConversationInFocusedPane = React.useCallback((conversationId: DConversationId | null) => {
    conversationId && openConversationInFocusedPane(conversationId);
  }, [openConversationInFocusedPane]);

  const handleOpenConversationInSplitPane = React.useCallback((conversationId: DConversationId | null) => {
    conversationId && openConversationInSplitPane(conversationId);
  }, [openConversationInSplitPane]);

  const handleNavigateHistoryInFocusedPane = React.useCallback((direction: 'back' | 'forward') => {
    if (navigateHistoryInFocusedPane(direction))
      showNextTitleChange.current = true;
  }, [navigateHistoryInFocusedPane]);

  // [effect] Handle the initial conversation intent
  React.useEffect(() => {
    intent.initialConversationId && handleOpenConversationInFocusedPane(intent.initialConversationId);
  }, [handleOpenConversationInFocusedPane, intent.initialConversationId]);

  // [effect] Show snackbar with the focused chat title after a history navigation in focused pane
  React.useEffect(() => {
    if (showNextTitleChange.current) {
      showNextTitleChange.current = false;
      const title = (focusedChatNumber >= 0 ? `#${focusedChatNumber + 1} · ` : '') + (focusedChatTitle || 'New Chat');
      const id = addSnackbar({ key: 'focused-title', message: title, type: 'title' });
      return () => removeSnackbar(id);
    }
  }, [focusedChatNumber, focusedChatTitle]);


  // Execution

  const handleExecuteAndOutcome = React.useCallback(async (chatExecuteMode: ChatExecuteMode, conversationId: DConversationId, callerNameDebug: string) => {
    const outcome = await _handleExecute(chatExecuteMode, conversationId, callerNameDebug);
    if (outcome === 'err-no-chatllm')
      openModelsSetup();
    else if (outcome === 'err-t2i-unconfigured')
      openPreferencesTab(PreferencesTab.Draw);
    else if (outcome === 'err-no-persona')
      addSnackbar({ key: 'chat-no-persona', message: 'No persona selected.', type: 'issue' });
    else if (outcome === 'err-no-conversation')
      addSnackbar({ key: 'chat-no-conversation', message: 'No active conversation.', type: 'issue' });
    else if (outcome === 'err-no-last-message')
      addSnackbar({ key: 'chat-no-conversation', message: 'No conversation history.', type: 'issue' });
    return outcome === true;
  }, [openModelsSetup, openPreferencesTab]);

  const handleComposerAction = React.useCallback((conversationId: DConversationId, chatExecuteMode: ChatExecuteMode, fragments: (DMessageContentFragment | DMessageAttachmentFragment)[], metadata?: DMessageMetadata): boolean => {

    // [multicast] send the message to all the panes
    const uniqueConversationIds = willMulticast
      ? Array.from(new Set([conversationId, ...paneUniqueConversationIds]))
      : [conversationId];

    // validate conversation existence
    const uniqueConverations = uniqueConversationIds.map(cId => getConversation(cId)).filter(Boolean) as DConversation[];
    if (!uniqueConverations.length)
      return false;

    // we loop to handle both the normal and multicast modes
    for (const conversation of uniqueConverations) {

      // create the user:message
      // NOTE: this can lead to multiple chat messages with data refs that are referring to the same dblobs,
      //       however, we already got transferred ownership of the dblobs at this point.
      const userMessage = createDMessageFromFragments('user', duplicateDMessageFragments(fragments)); // [chat] create user:message
      if (metadata) userMessage.metadata = duplicateDMessageMetadata(metadata);

      ConversationsManager.getHandler(conversation.id).messageAppend(userMessage); // [chat] append user message in each conversation

      // fire/forget
      void handleExecuteAndOutcome(chatExecuteMode /* various */, conversation.id, 'chat-composer-action'); // append user message, then '*-*'
    }

    return true;
  }, [paneUniqueConversationIds, handleExecuteAndOutcome, willMulticast]);

  const handleConversationExecuteHistory = React.useCallback(async (conversationId: DConversationId) => {
    await handleExecuteAndOutcome('generate-content', conversationId, 'chat-execute-history'); // replace with 'history', then 'generate-text'
  }, [handleExecuteAndOutcome]);

  const handleMessageRegenerateLastInFocusedPane = React.useCallback(async () => {
    const focusedConversation = getConversation(focusedPaneConversationId);
    if (focusedPaneConversationId && focusedConversation?.messages?.length) {
      const lastMessage = focusedConversation.messages[focusedConversation.messages.length - 1];
      if (lastMessage.role === 'assistant')
        ConversationsManager.getHandler(focusedPaneConversationId).historyTruncateTo(lastMessage.id, -1);
      await handleExecuteAndOutcome('generate-content', focusedConversation.id, 'chat-regenerate-last'); // truncate if assistant, then gen-text
    }
  }, [focusedPaneConversationId, handleExecuteAndOutcome]);

  const handleMessageBeamLastInFocusedPane = React.useCallback(async () => {
    // Ctrl + Shift + B
    const focusedConversation = getConversation(focusedPaneConversationId);
    if (focusedConversation?.messages?.length) {
      const lastMessage = focusedConversation.messages[focusedConversation.messages.length - 1];
      if (lastMessage.role === 'assistant')
        ConversationsManager.getHandler(focusedConversation.id).beamInvoke(focusedConversation.messages.slice(0, -1), [lastMessage], lastMessage.id);
      else if (lastMessage.role === 'user')
        ConversationsManager.getHandler(focusedConversation.id).beamInvoke(focusedConversation.messages, [], null);
    }
  }, [focusedPaneConversationId]);

  const handleTextDiagram = React.useCallback((diagramConfig: DiagramConfig | null) => setDiagramConfig(diagramConfig), []);

  const handleImagineFromText = React.useCallback(async (conversationId: DConversationId, messageText: string) => {
    const conversation = getConversation(conversationId);
    if (!conversation)
      return;
    const imaginedPrompt = await imaginePromptFromText(messageText, conversationId) || 'An error sign.';
    const imaginePrompMessage = createDMessageTextContent('user', imaginedPrompt);
    ConversationsManager.getHandler(conversationId).messageAppend(imaginePrompMessage);  // [chat] append user:imagine prompt
    await handleExecuteAndOutcome('generate-image', conversationId, 'chat-imagine-from-text'); // append message for 'imagine', then generate-image
  }, [handleExecuteAndOutcome]);

  const handleTextSpeak = React.useCallback(async (text: string): Promise<void> => {
    await speakText(text);
  }, []);


  // Chat actions

  const handleConversationNewInFocusedPane = React.useCallback((forceNoRecycle?: boolean) => {

    // create conversation (or recycle the existing top-of-stack empty conversation)
    const conversationId = (recycleNewConversationId && !forceNoRecycle)
      ? recycleNewConversationId
      : prependNewConversation(getConversationSystemPurposeId(focusedPaneConversationId) ?? undefined);

    // switch the focused pane to the new conversation
    handleOpenConversationInFocusedPane(conversationId);

    // if a folder is active, add the new conversation to the folder
    if (activeFolderId && conversationId)
      useFolderStore.getState().addConversationToFolder(activeFolderId, conversationId);

    // focus the composer
    composerTextAreaRef.current?.focus();

  }, [activeFolderId, focusedPaneConversationId, handleOpenConversationInFocusedPane, prependNewConversation, recycleNewConversationId]);

  const handleConversationImportDialog = React.useCallback(() => setTradeConfig({ dir: 'import' }), []);

  const handleConversationExport = React.useCallback((conversationId: DConversationId | null, exportAll: boolean) => {
    setTradeConfig({ dir: 'export', conversationId, exportAll });
  }, []);

  const handleFileOpenConversation = React.useCallback(() => {
    openAndLoadConversations(true)
      .then((outcome) => {
        // activate the last (most recent) imported conversation
        if (outcome?.activateConversationId) {
          showNextTitleChange.current = true;
          handleOpenConversationInFocusedPane(outcome.activateConversationId);
        }
      })
      .catch(() => {
        addSnackbar({ key: 'chat-import-fail', message: 'Could not open the file.', type: 'issue' });
      });
  }, [handleOpenConversationInFocusedPane]);

  const handleFileSaveConversation = React.useCallback((conversationId: DConversationId | null) => {
    const conversation = getConversation(conversationId);
    conversation && downloadConversation(conversation, 'json')
      .then(() => {
        addSnackbar({ key: 'chat-save-as-ok', message: 'File saved.', type: 'success' });
      })
      .catch((err: any) => {
        if (err?.name !== 'AbortError')
          addSnackbar({ key: 'chat-save-as-fail', message: `Could not save the file. ${err?.message || ''}`, type: 'issue' });
      });
  }, []);

  const handleConversationBranch = React.useCallback((srcConversationId: DConversationId, messageId: string | null): DConversationId | null => {
    // clone data
    const branchedConversationId = branchConversation(srcConversationId, messageId);

    // if a folder is active, add the new conversation to the folder
    if (activeFolderId && branchedConversationId)
      useFolderStore.getState().addConversationToFolder(activeFolderId, branchedConversationId);

    // replace/open a new pane with this
    showNextTitleChange.current = true;
    if (!isMultiAddable)
      handleOpenConversationInFocusedPane(branchedConversationId);
    else
      handleOpenConversationInSplitPane(branchedConversationId);

    return branchedConversationId;
  }, [activeFolderId, branchConversation, handleOpenConversationInFocusedPane, handleOpenConversationInSplitPane, isMultiAddable]);

  const handleConversationFlatten = React.useCallback((conversationId: DConversationId) => setFlattenConversationId(conversationId), []);

  const handleConfirmedClearConversation = React.useCallback(() => {
    if (clearConversationId) {
      ConversationsManager.getHandler(clearConversationId).historyClear();
      setClearConversationId(null);
    }
  }, [clearConversationId]);

  const handleConversationClear = React.useCallback((conversationId: DConversationId) => setClearConversationId(conversationId), []);

  const handleDeleteConversations = React.useCallback((conversationIds: DConversationId[], bypassConfirmation: boolean) => {
    if (!bypassConfirmation)
      return setDeleteConversationIds(conversationIds);

    // perform deletion, and return the next (or a new) conversation
    const nextConversationId = deleteConversations(conversationIds, /*focusedSystemPurposeId ??*/ undefined);

    // switch the focused pane to the new conversation - NOTE: this makes the assumption that deletion had impact on the focused pane
    handleOpenConversationInFocusedPane(nextConversationId);

    setDeleteConversationIds(null);

    // run GC for dblobs in this conversation
    void gcChatImageAssets(); // fire/forget
  }, [deleteConversations, handleOpenConversationInFocusedPane]);

  const handleConfirmedDeleteConversations = React.useCallback(() => {
    !!deleteConversationIds?.length && handleDeleteConversations(deleteConversationIds, true);
  }, [deleteConversationIds, handleDeleteConversations]);


  // Shortcuts

  const handleOpenChatLlmOptions = React.useCallback(() => {
    const chatLLMId = getChatLLMId();
    if (!chatLLMId) return;
    openLlmOptions(chatLLMId);
  }, [openLlmOptions]);

  useGlobalShortcuts('AppChat', React.useMemo(() => [
    // focused conversation
    { key: 'z', ctrl: true, shift: true, disabled: isFocusedChatEmpty, action: handleMessageRegenerateLastInFocusedPane, description: 'Retry' },
    { key: 'b', ctrl: true, shift: true, disabled: isFocusedChatEmpty, action: handleMessageBeamLastInFocusedPane, description: 'Beam' },
    { key: 'o', ctrl: true, action: handleFileOpenConversation },
    { key: 's', ctrl: true, action: () => handleFileSaveConversation(focusedPaneConversationId) },
    { key: 'n', ctrl: true, shift: true, action: handleConversationNewInFocusedPane },
    { key: 'x', ctrl: true, shift: true, action: () => isFocusedChatEmpty || (focusedPaneConversationId && handleConversationClear(focusedPaneConversationId)) },
    { key: 'd', ctrl: true, shift: true, action: () => focusedPaneConversationId && handleDeleteConversations([focusedPaneConversationId], false) },
    { key: '[', ctrl: true, action: () => handleNavigateHistoryInFocusedPane('back') },
    { key: ']', ctrl: true, action: () => handleNavigateHistoryInFocusedPane('forward') },
    // focused conversation llm
    { key: 'o', ctrl: true, shift: true, action: handleOpenChatLlmOptions },
  ], [focusedPaneConversationId, handleConversationClear, handleConversationNewInFocusedPane, handleDeleteConversations, handleFileOpenConversation, handleFileSaveConversation, handleMessageBeamLastInFocusedPane, handleMessageRegenerateLastInFocusedPane, handleNavigateHistoryInFocusedPane, handleOpenChatLlmOptions, isFocusedChatEmpty]));


  // Pluggable Optima components

  const barAltTitle = showAltTitleBar ? focusedChatTitle ?? 'No Chat' : null;

  const focusedBarContent = React.useMemo(() => beamOpenStoreInFocusedPane
      ? <ChatBarAltBeam beamStore={beamOpenStoreInFocusedPane} isMobile={isMobile} />
      : (barAltTitle === null)
        ? <ChatBarDropdowns conversationId={focusedPaneConversationId} />
        : <ChatBarAltTitle conversationId={focusedPaneConversationId} conversationTitle={barAltTitle} />
    , [barAltTitle, beamOpenStoreInFocusedPane, focusedPaneConversationId, isMobile],
  );

  const drawerContent = React.useMemo(() =>
      <ChatDrawerMemo
        isMobile={isMobile}
        activeConversationId={focusedPaneConversationId}
        activeFolderId={activeFolderId}
        chatPanesConversationIds={paneUniqueConversationIds}
        disableNewButton={disableNewButton}
        onConversationActivate={handleOpenConversationInFocusedPane}
        onConversationBranch={handleConversationBranch}
        onConversationNew={handleConversationNewInFocusedPane}
        onConversationsDelete={handleDeleteConversations}
        onConversationsExportDialog={handleConversationExport}
        onConversationsImportDialog={handleConversationImportDialog}
        setActiveFolderId={setActiveFolderId}
      />,
    [activeFolderId, disableNewButton, focusedPaneConversationId, handleConversationBranch, handleConversationExport, handleConversationImportDialog, handleConversationNewInFocusedPane, handleDeleteConversations, handleOpenConversationInFocusedPane, isMobile, paneUniqueConversationIds],
  );

  const focusedMenuItems = React.useMemo(() =>
      <ChatPageMenuItems
        isMobile={isMobile}
        conversationId={focusedPaneConversationId}
        disableItems={!focusedPaneConversationId || isFocusedChatEmpty}
        hasConversations={hasConversations}
        isMessageSelectionMode={isMessageSelectionMode}
        onConversationBranch={handleConversationBranch}
        onConversationClear={handleConversationClear}
        onConversationFlatten={handleConversationFlatten}
        // onConversationNew={handleConversationNewInFocusedPane}
        setIsMessageSelectionMode={setIsMessageSelectionMode}
      />,
    [focusedPaneConversationId, handleConversationBranch, handleConversationClear, handleConversationFlatten, hasConversations, isFocusedChatEmpty, isMessageSelectionMode, isMobile],
  );

  usePluggableOptimaLayout(focusedMenuItems, 'AppChat');

  return <>

    <OptimaPortalIn targetPortalId='optima-portal-drawer'>{drawerContent}</OptimaPortalIn>
    <OptimaPortalIn targetPortalId='optima-portal-toolbar'>{focusedBarContent}</OptimaPortalIn>

    <PanelGroup
      direction={isMobile ? 'vertical' : 'horizontal'}
      id='app-chat-panels'
    >

      {chatPanes.map((pane, idx) => {
        const _paneIsFocused = idx === focusedPaneIndex;
        const _paneConversationId = pane.conversationId;
        const _paneChatHandler = paneHandlers[idx] ?? null;
        const _paneBeamStore = paneBeamStores[idx] ?? null;
        const _paneBeamIsOpen = !!beamsOpens?.[idx] && !!_paneBeamStore;
        const _panesCount = chatPanes.length;
        const _keyAndId = `chat-pane-${pane.paneId}`;
        const _sepId = `sep-pane-${idx}`;
        return <React.Fragment key={_keyAndId}>

          <Panel
            id={_keyAndId}
            order={idx}
            collapsible={chatPanes.length === 2}
            defaultSize={(_panesCount === 3 && idx === 1) ? 34 : Math.round(100 / _panesCount)}
            minSize={20}
            onClick={(event) => {
              const setFocus = chatPanes.length < 2 || !event.altKey;
              setFocusedPaneIndex(setFocus ? idx : -1);
            }}
            onCollapse={() => {
              // NOTE: despite the delay to try to let the draggin settle, there seems to be an issue with the Pane locking the screen
              // setTimeout(() => removePane(idx), 50);
              // more than 2 will result in an assertion from the framework
              if (chatPanes.length === 2) removePane(idx);
            }}
            style={{
              // for anchoring the scroll button in place
              position: 'relative',
              ...(isMultiPane ? {
                borderRadius: '0.375rem',
                border: `2px solid ${_paneIsFocused
                  ? ((willMulticast || !isMultiConversationId) ? theme.palette.primary.solidBg : theme.palette.primary.solidBg)
                  : ((willMulticast || !isMultiConversationId) ? theme.palette.primary.softActiveBg : theme.palette.background.level1)}`,
                // DISABLED on 2024-03-13, it gets in the way quite a lot
                // filter: (!willMulticast && !_paneIsFocused)
                //   ? (!isMultiConversationId ? 'grayscale(66.67%)' /* clone of the same */ : 'grayscale(66.67%)')
                //   : undefined,
              } : {
                // NOTE: this is a workaround for the 'stuck-after-collapse-close' issue. We will collapse the 'other' pane, which
                // will get it removed (onCollapse), and somehow this pane will be stuck with a pointerEvents: 'none' style, which de-facto
                // disables further interaction with the chat. This is a workaround to re-enable the pointer events.
                // The root cause seems to be a Dragstate not being reset properly, however the pointerEvents has been set since 0.0.56 while
                // it was optional before: https://github.com/bvaughn/react-resizable-panels/issues/241
                pointerEvents: 'auto',
              }),
            }}
          >

            <ScrollToBottom
              bootToBottom
              stickToBottomInitial
              sx={{ display: 'flex', flexDirection: 'column' }}
            >

              {!_paneBeamIsOpen && (
                <ChatMessageList
                  conversationId={_paneConversationId}
                  conversationHandler={_paneChatHandler}
                  capabilityHasT2I={capabilityHasT2I}
                  chatLLMContextTokens={chatLLM?.contextTokens ?? null}
                  fitScreen={isMobile || isMultiPane}
                  isMobile={isMobile}
                  isMessageSelectionMode={isMessageSelectionMode}
                  setIsMessageSelectionMode={setIsMessageSelectionMode}
                  onConversationBranch={handleConversationBranch}
                  onConversationExecuteHistory={handleConversationExecuteHistory}
                  onTextDiagram={handleTextDiagram}
                  onTextImagine={handleImagineFromText}
                  onTextSpeak={handleTextSpeak}
                  sx={{
                    flexGrow: 1,
                  }}
                />
              )}

              {_paneBeamIsOpen && (
                <ChatBeamWrapper
                  beamStore={_paneBeamStore}
                  isMobile={isMobile}
                  inlineSx={{
                    flexGrow: 1,
                    // minHeight: 'calc(100vh - 69px - var(--AGI-Nav-width))',
                  }}
                />
              )}

              {/* Visibility and actions are handled via Context */}
              <ScrollToBottomButton />

            </ScrollToBottom>

          </Panel>

          {/* Panel Separators & Resizers */}
          {idx < _panesCount - 1 && (
            <PanelResizeHandle id={_sepId}>
              <PanelResizeInset />
            </PanelResizeHandle>
          )}

        </React.Fragment>;
      })}

    </PanelGroup>

    <Composer
      isMobile={isMobile}
      chatLLM={chatLLM}
      composerTextAreaRef={composerTextAreaRef}
      targetConversationId={focusedPaneConversationId}
      capabilityHasT2I={capabilityHasT2I}
      isMulticast={!isMultiConversationId ? null : isComposerMulticast}
      isDeveloperMode={isFocusedChatDeveloper}
      onAction={handleComposerAction}
      onTextImagine={handleImagineFromText}
      setIsMulticast={setIsComposerMulticast}
      sx={beamOpenStoreInFocusedPane ? composerClosedSx : composerOpenSx}
    />

    {/* Diagrams */}
    {!!diagramConfig && <DiagramsModal config={diagramConfig} onClose={() => setDiagramConfig(null)} />}

    {/* Flatten */}
    {!!flattenConversationId && (
      <FlattenerModal
        conversationId={flattenConversationId}
        onConversationBranch={handleConversationBranch}
        onClose={() => setFlattenConversationId(null)}
      />
    )}

    {/* Import / Export  */}
    {!!tradeConfig && (
      <TradeModal
        config={tradeConfig}
        onConversationActivate={handleOpenConversationInFocusedPane}
        onClose={() => setTradeConfig(null)}
      />
    )}

    {/* [confirmation] Reset Conversation */}
    {!!clearConversationId && (
      <ConfirmationModal
        open onClose={() => setClearConversationId(null)} onPositive={handleConfirmedClearConversation}
        confirmationText='Are you sure you want to discard all messages?'
        positiveActionText='Clear conversation'
      />
    )}

    {/* [confirmation] Delete All */}
    {!!deleteConversationIds?.length && (
      <ConfirmationModal
        open onClose={() => setDeleteConversationIds(null)} onPositive={handleConfirmedDeleteConversations}
        confirmationText={`Are you absolutely sure you want to delete ${deleteConversationIds.length === 1 ? 'this conversation' : 'these conversations'}? This action cannot be undone.`}
        positiveActionText={deleteConversationIds.length === 1 ? 'Delete conversation' : `Yes, delete all ${deleteConversationIds.length} conversations`}
      />
    )}

  </>;
}
