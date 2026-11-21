//! Edit > Find on macOS: AppKit's find bar over the web view, with WKWebView as the NSTextFinder client.
use std::cell::{Cell, OnceCell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSTextFinder, NSTextFinderAction, NSTextFinderBarContainer, NSTextFinderClient, NSView};
use objc2_foundation::{NSObject, NSPoint, NSRect, NSSize};
use tauri::WebviewWindow;

pub enum Action {
    Show,
    Next,
    Previous,
    UseSelection,
}

impl Action {
    pub fn from_menu_id(id: &str) -> Option<Self> {
        match id {
            "find" => Some(Self::Show),
            "find-next" => Some(Self::Next),
            "find-previous" => Some(Self::Previous),
            "find-selection" => Some(Self::UseSelection),
            _ => None,
        }
    }

    fn text_finder_action(&self) -> NSTextFinderAction {
        match self {
            Self::Show => NSTextFinderAction::ShowFindInterface,
            Self::Next => NSTextFinderAction::NextMatch,
            Self::Previous => NSTextFinderAction::PreviousMatch,
            Self::UseSelection => NSTextFinderAction::SetSearchString,
        }
    }
}

pub struct BarIvars {
    web: Retained<NSView>,
    bar: RefCell<Option<Retained<NSView>>>,
    visible: Cell<bool>,
}

define_class!(
    /// Shows the find bar along the bottom of the window and shrinks the web view to make room,
    /// so the bar never sits under the window buttons in the chat's top row.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = BarIvars]
    struct FindBar;

    unsafe impl NSObjectProtocol for FindBar {}

    unsafe impl NSTextFinderBarContainer for FindBar {
        #[unsafe(method_id(findBarView))]
        fn find_bar_view(&self) -> Option<Retained<NSView>> {
            self.ivars().bar.borrow().clone()
        }

        #[unsafe(method(setFindBarView:))]
        fn set_find_bar_view(&self, view: Option<&NSView>) {
            if let Some(old) = self.ivars().bar.replace(view.map(NSView::retain)) {
                old.removeFromSuperview();
            }
            self.layout();
        }

        #[unsafe(method(isFindBarVisible))]
        fn is_find_bar_visible(&self) -> bool {
            self.ivars().visible.get()
        }

        #[unsafe(method(setFindBarVisible:))]
        fn set_find_bar_visible(&self, visible: bool) {
            self.ivars().visible.set(visible);
            self.layout();
            if !visible {
                if let Some(window) = self.ivars().web.window() {
                    window.makeFirstResponder(Some(&self.ivars().web));
                }
            }
        }

        #[unsafe(method(findBarViewDidChangeHeight))]
        fn find_bar_view_did_change_height(&self) {
            self.layout();
        }

        #[unsafe(method_id(contentView))]
        fn content_view(&self) -> Option<Retained<NSView>> {
            Some(self.ivars().web.clone())
        }
    }
);

impl FindBar {
    fn new(web: Retained<NSView>, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(BarIvars { web, bar: RefCell::new(None), visible: Cell::new(false) });
        unsafe { msg_send![super(this), init] }
    }

    fn layout(&self) {
        let web = &self.ivars().web;
        let Some(parent) = (unsafe { web.superview() }) else { return };
        let size = parent.bounds().size;
        let flipped = parent.isFlipped();
        let bar = self.ivars().bar.borrow();
        let height = match bar.as_deref() {
            Some(bar) if self.ivars().visible.get() => {
                let height = bar.frame().size.height;
                let y = if flipped { size.height - height } else { 0.0 };
                bar.setFrame(NSRect::new(NSPoint::new(0.0, y), NSSize::new(size.width, height)));
                let edge = if flipped { NSAutoresizingMaskOptions::ViewMinYMargin } else { NSAutoresizingMaskOptions::ViewMaxYMargin };
                bar.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | edge);
                if unsafe { bar.superview() }.is_none() {
                    parent.addSubview(bar);
                }
                height
            }
            Some(bar) => {
                bar.removeFromSuperview();
                0.0
            }
            None => 0.0,
        };
        let y = if flipped { 0.0 } else { height };
        web.setFrame(NSRect::new(NSPoint::new(0.0, y), NSSize::new(size.width, size.height - height)));
    }
}

thread_local! {
    static FINDER: OnceCell<(Retained<NSTextFinder>, Retained<FindBar>)> = const { OnceCell::new() };
}

fn text_finder(web: &NSView, mtm: MainThreadMarker) -> (Retained<NSTextFinder>, Retained<FindBar>) {
    let use_platform_find_ui = sel!(_setUsePlatformFindUI:);
    if web.respondsToSelector(use_platform_find_ui) {
        // WebKit's own find overlay and match selection reach into iframes, where AppKit's highlight lands in the wrong place.
        let _: () = unsafe { msg_send![web, _setUsePlatformFindUI: false] };
    }
    let finder = NSTextFinder::new();
    let bar = FindBar::new(web.retain(), mtm);
    let client: &ProtocolObject<dyn NSTextFinderClient> = unsafe { &*(web as *const NSView).cast() };
    unsafe {
        finder.setClient(Some(client));
        finder.setFindBarContainer(Some(ProtocolObject::from_ref(&*bar)));
    }
    finder.setIncrementalSearchingEnabled(true);
    (finder, bar)
}

pub fn perform(window: &WebviewWindow, action: Action) {
    let _ = window.with_webview(move |webview| {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let web: &NSView = unsafe { &*webview.inner().cast() };
        FINDER.with(|cell| cell.get_or_init(|| text_finder(web, mtm)).0.performAction(action.text_finder_action()));
    });
}
