# Product Requirements Document — llm-local-monitor

**Version:** 1.1
**Date:** 2026-05-10
**Author:** Jerzy Maczewski
**Purpose:** Webowy dashboard do monitorowania serwera GPU z Ollamą

---

## Executive Summary

Dashboard zastępuje ręczne SSH-owanie na serwer GPU (`$LLM_HOST`) w celu sprawdzenia stanu załadowanych modeli LLM, wykorzystania GPU i alokacji pamięci RAM. Udostępnia też przyciski sterowania zasilaniem (wybudź/wyłącz) i restartowania usługi Ollama — bez konieczności otwierania terminala.

---

## Problem Statement

### Obecne wyzwania

- Sprawdzenie załadowanych modeli wymaga ręcznego logowania do konsoli TrueNAS App
- Monitorowanie GPU wymaga dedykowanego okna terminala z `watch -n 2 nvidia-smi`
- Podgląd podziału pamięci RAM wymaga wejścia do dashboardu TrueNAS UI
- Wybudzenie serwera wymaga znajomości komendy IPMI i adresu BMC
- Brak scentralizowanego widoku stanu serwera LLM

### Kontekst

- Serwer GPU bywa uśpiony poza sesjami LLM — wybudzanie przez IPMI
- Maszyna dostępna tylko w sieci lokalnej
- Jedynym użytkownikiem jest właściciel

---

## Target Users

### Primary User

Właściciel/operator — jedyna osoba używająca narzędzia. Potrzebuje szybkiego wglądu w stan serwera przed uruchomieniem sesji LLM i w jej trakcie, bez otwierania osobnych terminali.

---

## Functional Requirements

### FR1: Monitoring w czasie rzeczywistym

- **FR1.1** Wyświetl stan hosta (online/offline)
- **FR1.2** Wyświetl listę aktywnie załadowanych modeli LLM z parametrami (rozmiar, kwantyzacja, użycie GPU/CPU, kontekst, czas wygaśnięcia)
- **FR1.3** Wyświetl statystyki GPU: utylizacja, VRAM, temperatura, pobór mocy
- **FR1.4** Wyświetl rozkład pamięci RAM: wolna / ZFS ARC / usługi
- **FR1.5** Wyświetl statystyki kontenera Ollama: CPU%, RAM, Block I/O, Network, status aplikacji, wersja, dostępność aktualizacji
- **FR1.6** Auto-odświeżanie co 5 sekund bez ingerencji użytkownika

### FR2: Sterowanie serwerem

- **FR2.1** Przycisk **Wake** — zdalnie włącza serwer przez BMC
- **FR2.2** Przycisk **Wyłącz** — gracefully wyłącza serwer
- **FR2.3** Przycisk **Restart Ollama** — restartuje usługę Ollama bez restartu serwera
- **FR2.4** Przyciski aktywne/nieaktywne zależnie od stanu hosta

### FR3: Dostępność

- **FR3.1** Brak autoryzacji — narzędzie internal, dostęp z sieci lokalnej
- **FR3.2** Brak ekspozycji publicznej — tylko sieć lokalna

---

## Non-functional Requirements

- **NFR1** Czas odpowiedzi dashboardu < 1 s gdy host online
- **NFR2** Gdy host offline: panel zaktualizowany w < 5 s
- **NFR3** Single-page — działa w każdej nowoczesnej przeglądarce bez instalacji
- **NFR4** Docker container — restart: unless-stopped, działa po restarcie hosta Dockge

---

## Success Metrics

- **M1** Brak potrzeby otwierania terminala SSH do sprawdzenia stanu serwera LLM
- **M2** Czas do informacji "czy model załadowany" < 5 s od otwarcia przeglądarki
- **M3** Wake/Wyłącz/Restart Ollama działa z dashboardu bez dodatkowych czynności

---

## Constraints & Assumptions

- **C1** Dostępność: monitor działa tylko z sieci lokalnej
- **C2** Serwer GPU musi mieć autoryzowany klucz SSH dla konta administracyjnego
- **A1** Serwer GPU jest dostępny przez SSH gdy jest włączony
- **A2** Sterowniki NVIDIA są zainstalowane na hoście TrueNAS CE

---

## Out of Scope (v1)

- Historia metryk / wykresy (v2)
- Notyfikacje push (email, Telegram)
- Monitorowanie innych hostów
- Ekspozycja publiczna
- Streaming logów systemowych
