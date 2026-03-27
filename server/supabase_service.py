from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException

from .database import get_supabase_client, parse_payouts
from .schemas import LeaguePayload, MatchPayload, PlayerPayload, WinnersPayload


def get_state() -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    # Get league data
    league_response = supabase.table("league").select("*").limit(1).execute()
    league = league_response.data[0] if league_response.data else None
    
    # Get players
    players_response = supabase.table("players").select("*").order("name").execute()
    players = players_response.data
    
    # Get matches
    matches_response = supabase.table("matches").select("*").order("id", desc=True).execute()
    matches = matches_response.data

    return {
        "league": {
            "name": league["name"],
            "tournament": league["tournament"],
            "entry_fee": league["entry_fee"],
            "active_player_count": league["active_player_count"],
            "default_winner_count": league["default_winner_count"],
            "payouts": parse_payouts(league["payouts_json"]),
        }
        if league
        else None,
        "players": players,
        "matches": [
            {
                **match,
                "payouts": parse_payouts(match["payouts_json"]),
            }
            for match in matches
        ],
    }


def upsert_league(payload: LeaguePayload) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    payouts_json = json.dumps(payload.payouts)
    
    # Check if league exists
    existing_response = supabase.table("league").select("*").limit(1).execute()
    
    if existing_response.data:
        # Update existing
        supabase.table("league").update({
            "name": payload.name.strip(),
            "tournament": payload.tournament.strip(),
            "entry_fee": payload.entry_fee,
            "active_player_count": payload.active_player_count,
            "default_winner_count": payload.default_winner_count,
            "payouts_json": payouts_json,
        }).eq("id", existing_response.data[0]["id"]).execute()
    else:
        # Insert new
        supabase.table("league").insert({
            "name": payload.name.strip(),
            "tournament": payload.tournament.strip(),
            "entry_fee": payload.entry_fee,
            "active_player_count": payload.active_player_count,
            "default_winner_count": payload.default_winner_count,
            "payouts_json": payouts_json,
        }).execute()
    
    return {"message": "League settings saved"}


def add_player(payload: PlayerPayload) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    try:
        supabase.table("players").insert({
            "name": payload.name.strip()
        }).execute()
    except Exception as exc:
        if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
            raise HTTPException(status_code=409, detail="Player already exists")
        raise
    
    return {"message": "Player added"}


def delete_player(player_id: int) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    supabase.table("players").delete().eq("id", player_id).execute()
    return {"message": "Player removed"}


def add_match(payload: MatchPayload) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    payouts_json = json.dumps(payload.payouts) if payload.payouts else None
    
    supabase.table("matches").insert({
        "title": payload.title.strip(),
        "match_date": payload.match_date.strip(),
        "winner_count": payload.winner_count,
        "payouts_json": payouts_json,
    }).execute()
    
    return {"message": "Match added"}


def save_winners(match_id: int, payload: WinnersPayload) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    # Get match and league data
    match_response = supabase.table("matches").select("*").eq("id", match_id).execute()
    league_response = supabase.table("league").select("*").limit(1).execute()
    
    if not match_response.data or not league_response.data:
        raise HTTPException(status_code=404, detail="League or match not found")
    
    match = match_response.data[0]
    league = league_response.data[0]
    
    payouts = parse_payouts(match["payouts_json"]) or parse_payouts(league["payouts_json"])
    winner_limit = int(match["winner_count"] or league["default_winner_count"])
    
    rank_to_players = {row.rank: [pid for pid in row.player_ids] for row in payload.ranks}
    
    used_players: set[int] = set()
    for rank_players in rank_to_players.values():
        for player_id in rank_players:
            if player_id in used_players:
                raise HTTPException(status_code=400, detail="A player is assigned in multiple ranks")
            used_players.add(player_id)
    
    # Delete existing winner entries
    supabase.table("winner_entries").delete().eq("match_id", match_id).execute()
    
    # Add new winner entries
    rank = 1
    while rank <= winner_limit:
        winners = rank_to_players.get(rank, [])
        if not winners:
            rank += 1
            continue
        
        tie_size = len(winners)
        payout_end_rank = min(winner_limit, rank + tie_size - 1)
        pooled_amount = sum(float(payouts.get(r, 0.0)) for r in range(rank, payout_end_rank + 1))
        split_amount = round(pooled_amount / tie_size, 2) if tie_size else 0.0
        
        for player_id in winners:
            supabase.table("winner_entries").insert({
                "match_id": match_id,
                "rank": rank,
                "player_id": player_id,
                "amount": split_amount,
            }).execute()
        
        rank += max(1, tie_size)
    
    # Update match status
    supabase.table("matches").update({"status": "completed"}).eq("id", match_id).execute()
    
    return {"message": "Winners saved"}


def cancel_match(match_id: int) -> dict[str, str]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    # Get match and league data
    match_response = supabase.table("matches").select("*").eq("id", match_id).execute()
    league_response = supabase.table("league").select("*").limit(1).execute()
    players_response = supabase.table("players").select("id").order("id").execute()
    
    if not match_response.data or not league_response.data:
        raise HTTPException(status_code=404, detail="League or match not found")
    
    match = match_response.data[0]
    league = league_response.data[0]
    players = players_response.data
    
    # Delete existing winner entries
    supabase.table("winner_entries").delete().eq("match_id", match_id).execute()
    
    if players:
        pool = float(league["entry_fee"]) * len(players)
        split = round(pool / len(players), 2)
        remainder = round(pool - (split * len(players)), 2)
        
        for idx, player in enumerate(players):
            amount = split + (remainder if idx == 0 else 0.0)
            supabase.table("winner_entries").insert({
                "match_id": match_id,
                "rank": 0,
                "player_id": player["id"],
                "amount": round(amount, 2),
            }).execute()
    
    # Update match status
    supabase.table("matches").update({"status": "canceled"}).eq("id", match_id).execute()
    
    return {"message": "Match marked as canceled and refund distributed equally"}


def get_ledger() -> dict[str, Any]:
    supabase = get_supabase_client()
    if not supabase:
        raise HTTPException(status_code=500, detail="Supabase not configured")
    
    # Get league data
    league_response = supabase.table("league").select("*").limit(1).execute()
    if not league_response.data:
        return {"rows": [], "completed_matches": 0, "entry_fee": 0}
    
    league = league_response.data[0]
    
    # Get completed matches count
    matches_response = supabase.table("matches").select("id", count="exact").in_("status", ["completed", "canceled"]).execute()
    completed_matches = matches_response.count or 0
    
    # Get players
    players_response = supabase.table("players").select("id, name").order("name").execute()
    players = players_response.data
    
    # Get winnings
    winnings_response = supabase.table("winner_entries").select("player_id, amount").execute()
    winnings = winnings_response.data
    
    winnings_map = {}
    for item in winnings:
        player_id = item["player_id"]
        amount = float(item["amount"])
        winnings_map[player_id] = winnings_map.get(player_id, 0) + amount
    
    entry_fee = float(league["entry_fee"])
    
    rows = []
    for player in players:
        spent = round(completed_matches * entry_fee, 2)
        won = round(winnings_map.get(player["id"], 0.0), 2)
        net = round(won - spent, 2)
        rows.append({
            "player_id": player["id"],
            "name": player["name"],
            "spent": spent,
            "won": won,
            "net": net,
        })
    
    return {
        "rows": rows,
        "completed_matches": completed_matches,
        "entry_fee": entry_fee,
    }
