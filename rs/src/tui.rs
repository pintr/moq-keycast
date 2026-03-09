use anyhow::Context;
use crossterm::cursor::Hide;
use crossterm::event::{Event, EventStream, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::execute;
use futures::StreamExt;
use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph},
    DefaultTerminal, Frame,
};
use std::collections::BTreeMap;
use std::io::stdout;
use tokio::sync::mpsc;

/// Events forwarded from the subscriber task to the TUI.
pub enum PeerEvent {
    /// A peer appeared in the room (may not have typed yet).
    Joined(String),
    /// A peer's typing buffer was updated (username → current text).
    Update(String, String),
    /// A peer disconnected or went offline.
    Offline(String),
}

struct App {
    room: String,
    username: String,
    /// Each remote peer's live text, keyed by username (BTreeMap keeps display order stable).
    peers: BTreeMap<String, String>,
    /// The local user's current input.
    input: String,
}

impl App {
    fn new(room: String, username: String) -> Self {
        Self {
            room,
            username,
            peers: BTreeMap::new(),
            input: String::new(),
        }
    }
}

/// Initialise the terminal, run the TUI event loop, then restore the terminal.
pub async fn run(
    room: String,
    username: String,
    typing_tx: mpsc::UnboundedSender<String>,
    mut peer_rx: mpsc::UnboundedReceiver<PeerEvent>,
) -> anyhow::Result<()> {
    let mut terminal = ratatui::init();
    // Hide the real cursor immediately — ratatui already does this after each
    // draw() call, but doing it here ensures it is hidden before the first
    // frame and after any external write (e.g. tracing output from a background
    // task) that might have temporarily shown it on the alternate screen.
    let _ = execute!(stdout(), Hide);
    let result = event_loop(&mut terminal, room, username, typing_tx, &mut peer_rx).await;
    ratatui::restore();
    result
}

async fn event_loop(
    terminal: &mut DefaultTerminal,
    room: String,
    username: String,
    typing_tx: mpsc::UnboundedSender<String>,
    peer_rx: &mut mpsc::UnboundedReceiver<PeerEvent>,
) -> anyhow::Result<()> {
    let mut app = App::new(room, username);
    let mut events = EventStream::new();

    loop {
        terminal.draw(|f| render(f, &app)).context("render")?;

        tokio::select! {
            // ── Keyboard input ──────────────────────────────────────────────
            Some(Ok(event)) = events.next() => {
                let Event::Key(key) = event else { continue };
                if key.kind != KeyEventKind::Press { continue; }

                match key.code {
                    // Quit
                    KeyCode::Esc => break,
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => break,

                    // Type a character → publish immediately
                    KeyCode::Char(c) => {
                        app.input.push(c);
                        let _ = typing_tx.send(app.input.clone());
                    }

                    // Backspace → remove last char → publish
                    KeyCode::Backspace => {
                        app.input.pop();
                        let _ = typing_tx.send(app.input.clone());
                    }

                    // Enter → clear the input, publish empty string (resets others' view)
                    KeyCode::Enter => {
                        app.input.clear();
                        let _ = typing_tx.send(String::new());
                    }

                    _ => {}
                }
            }

            // ── Peer events from subscriber ─────────────────────────────────
            Some(event) = peer_rx.recv() => {
                match event {
                    PeerEvent::Joined(username) => {
                        app.peers.entry(username).or_insert_with(String::new);
                    }
                    PeerEvent::Update(username, text) => {
                        app.peers.insert(username, text);
                    }
                    PeerEvent::Offline(username) => {
                        app.peers.remove(&username);
                    }
                }
            }
        }
    }

    Ok(())
}

fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Split into a scrollable peer-feed area and a fixed-height local-input bar.
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),    // peer feeds — takes all remaining space
            Constraint::Length(3), // local input — always visible at the bottom
        ])
        .split(area);

    // ── Peer feeds ──────────────────────────────────────────────────────────
    let peer_items: Vec<ListItem> = if app.peers.is_empty() {
        vec![ListItem::new(Line::from(Span::styled(
            "  Waiting for others to join…",
            Style::default().fg(Color::DarkGray),
        )))]
    } else {
        app.peers
            .iter()
            .map(|(name, text)| {
                let label = Span::styled(
                    format!("  {name}: "),
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                );
                let content = if text.is_empty() {
                    Span::styled("…", Style::default().fg(Color::DarkGray))
                } else {
                    Span::raw(text.clone())
                };
                ListItem::new(Line::from(vec![label, content]))
            })
            .collect()
    };

    let title = format!(
        " moq-chat :: {} | {} peer{} ",
        app.room,
        app.peers.len(),
        if app.peers.len() == 1 { "" } else { "s" }
    );

    let peers_widget = List::new(peer_items).block(
        Block::default()
            .title(title)
            .title_style(
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            )
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::DarkGray)),
    );
    frame.render_widget(peers_widget, chunks[0]);

    // ── Local input ─────────────────────────────────────────────────────────
    // Use a block character as a fake cursor so the real terminal cursor
    // stays hidden (ratatui hides it after every draw when set_cursor_position
    // is not called).  A fixed character avoids the "always at the bottom"
    // problem that appears when the real cursor is shown via set_cursor_position.
    let input_line = format!("  {}: {}█", app.username, app.input);
    let input_widget = Paragraph::new(input_line).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Green)),
    );
    frame.render_widget(input_widget, chunks[1]);
}
