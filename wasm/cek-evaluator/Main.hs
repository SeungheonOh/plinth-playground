{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE TypeApplications #-}

module Main (main) where

import CekArguments (UplcTerm, parseArgument)
import Data.ByteString qualified as ByteString
import Data.ByteString.Lazy qualified as LazyByteString
import Data.SatInt (unSatInt)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import Numeric (showHex)
import PlutusCore qualified as PLC
import PlutusCore.Evaluation.Machine.ExBudget
  ( ExBudget (..)
  , ExRestrictingBudget (..)
  , minusExBudget
  )
import PlutusCore.Evaluation.Machine.ExBudgetingDefaults (defaultCekParametersForTesting)
import PlutusCore.Evaluation.Machine.ExMemory (ExCPU (..), ExMemory (..))
import PlutusCore.Flat (unflat)
import PlutusCore.Pretty (displayPlc)
import System.Environment (getArgs)
import UntypedPlutusCore qualified as UPLC
import UntypedPlutusCore.Evaluation.Machine.Cek qualified as Cek

type FlatUplc =
  UPLC.UnrestrictedProgram
    PLC.NamedDeBruijn
    PLC.DefaultUni
    PLC.DefaultFun
    ()

main :: IO ()
main = getArgs >>= \case
  inputPath : encodedArguments -> evaluateFile inputPath encodedArguments
  _ -> emitError "usage: evaluate-uplc.wasm PROGRAM.flat [ARG ...]"

evaluateFile :: FilePath -> [String] -> IO ()
evaluateFile inputPath encodedArguments = do
  encoded <- LazyByteString.readFile inputPath
  case unflat @FlatUplc encoded of
    Left err -> emitError $ "Flat decode failed: " <> show err
    Right (UPLC.UnrestrictedProgram (UPLC.Program _ _ programTerm)) ->
      case traverse parseArgument encodedArguments of
        Left err -> emitError err
        Right argumentTerms -> evaluateTerm $ foldl (UPLC.Apply ()) programTerm argumentTerms

evaluateTerm :: UplcTerm -> IO ()
evaluateTerm term = do
  let budgetLimit = ExBudget (ExCPU 15000000000) (ExMemory 40000000)
      Cek.CekReport result (Cek.RestrictingSt (ExRestrictingBudget remainingBudget)) logs =
        Cek.runCekDeBruijn
          defaultCekParametersForTesting
          (Cek.restricting $ ExRestrictingBudget budgetLimit)
          Cek.logEmitter
          term
      budget = budgetLimit `minusExBudget` remainingBudget
  emitBudget budget
  mapM_ (emitHexRecord "LOG" . Text.encodeUtf8) logs
  case Cek.cekResultToEither result of
    Left err -> emitHexRecord "ERROR" . Text.encodeUtf8 . Text.pack $ show err
    Right value -> emitHexRecord "RESULT" . Text.encodeUtf8 $ displayPlc value

emitBudget :: ExBudget -> IO ()
emitBudget
  ExBudget
    { exBudgetCPU = ExCPU cpu
    , exBudgetMemory = ExMemory memory
    } =
    putStrLn $ "BUDGET\t" <> show (unSatInt cpu) <> "\t" <> show (unSatInt memory)

emitError :: String -> IO ()
emitError = emitHexRecord "ERROR" . Text.encodeUtf8 . Text.pack

emitHexRecord :: String -> ByteString.ByteString -> IO ()
emitHexRecord label bytes = putStrLn $ label <> "\t" <> concatMap byteHex (ByteString.unpack bytes)
  where
    byteHex byte = case showHex byte "" of
      [digit] -> ['0', digit]
      digits -> digits
