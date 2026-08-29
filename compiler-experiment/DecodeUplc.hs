{-# LANGUAGE TypeApplications #-}

module Main (main) where

import Data.ByteString.Lazy qualified as ByteString
import PlutusCore qualified as PLC
import PlutusCore.Flat (unflat)
import PlutusCore.Pretty (displayPlc)
import System.Environment (getArgs)
import UntypedPlutusCore qualified as UPLC

type FlatUplc =
  UPLC.UnrestrictedProgram
    PLC.NamedDeBruijn
    PLC.DefaultUni
    PLC.DefaultFun
    ()

main :: IO ()
main = do
  [inputPath] <- getArgs
  encoded <- ByteString.readFile inputPath
  case unflat @FlatUplc encoded of
    Left err -> fail $ "invalid Flat UPLC: " <> show err
    Right program -> putStrLn $ displayPlc program
